const { tmpdir } = require('os')
const path = require('path')
const archiver = require('archiver')
const globby = require('globby')
const AWS = require('aws-sdk')
const { contains, isNil, last, split, equals, not, pick } = require('ramda')
const { readFile, createReadStream, createWriteStream } = require('fs-extra')
const { utils } = require('@serverless/core')

const VALID_FORMATS = ['zip', 'tar']
const isValidFormat = (format) => contains(format, VALID_FORMATS)

const packDir = async (inputDirPath, outputFilePath, include = [], exclude = [], prefix) => {
  const format = last(split('.', outputFilePath))

  if (!isValidFormat(format)) {
    throw new Error('Please provide a valid format. Either a "zip" or a "tar"')
  }

  const patterns = ['**/*']

  if (!isNil(exclude)) {
    exclude.forEach((excludedItem) => patterns.push(`!${excludedItem}`))
  }

  const files = (await globby(patterns, { cwd: inputDirPath, dot: true }))
    .sort() // we must sort to ensure correct hash
    .map((file) => ({
      input: path.join(inputDirPath, file),
      output: prefix ? path.join(prefix, file) : file
    }))

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputFilePath)
    const archive = archiver(format, {
      zlib: { level: 9 }
    })

    output.on('open', () => {
      archive.pipe(output)

      // we must set the date to ensure correct hash
      files.forEach((file) =>
        archive.append(createReadStream(file.input), { name: file.output, date: new Date(0) })
      )

      if (!isNil(include)) {
        include.forEach((file) => {
          const stream = createReadStream(file)
          archive.append(stream, { name: path.basename(file), date: new Date(0) })
        })
      }

      archive.finalize()
    })

    archive.on('error', (err) => reject(err))
    output.on('close', () => resolve(outputFilePath))
  })
}

const getAccountId = async (aws) => {
  const STS = new aws.STS()
  const res = await STS.getCallerIdentity({}).promise()
  return res.Account
}

const createLambda = async ({
  lambda,
  name,
  handler,
  memory,
  timeout,
  runtime,
  env,
  description,
  zipPath,
  bucket,
  roleArn,
  autoRoleArn,
  layer
}) => {
  const params = {
    FunctionName: name,
    Code: {},
    Description: description,
    Handler: handler,
    MemorySize: memory,
    Publish: true,
    Role: roleArn || autoRoleArn,
    Runtime: runtime,
    Timeout: timeout,
    Environment: {
      Variables: env
    }
  }

  if (layer && layer.arn) {
    params.Layers = [layer.arn]
  }

  if (bucket) {
    params.Code.S3Bucket = bucket
    params.Code.S3Key = path.basename(zipPath)
  } else {
    params.Code.ZipFile = await readFile(zipPath)
  }

  const res = await lambda.createFunction(params).promise()

  return { arn: res.FunctionArn, hash: res.CodeSha256 }
}

const updateLambdaConfig = async ({
  lambda,
  name,
  handler,
  memory,
  timeout,
  runtime,
  env,
  description,
  roleArn,
  autoRoleArm,
  layer
}) => {
  const functionConfigParams = {
    FunctionName: name,
    Description: description,
    Handler: handler,
    MemorySize: memory,
    Role: roleArn || autoRoleArm,
    Runtime: runtime,
    Timeout: timeout,
    Environment: {
      Variables: env
    }
  }

  if (layer && layer.arn) {
    functionConfigParams.Layers = [layer.arn]
  }

  const res = await lambda.updateFunctionConfiguration(functionConfigParams).promise()

  return { arn: res.FunctionArn, hash: res.CodeSha256 }
}

const updateLambdaCode = async ({ lambda, name, zipPath, bucket }) => {
  const functionCodeParams = {
    FunctionName: name,
    Publish: true
  }

  if (bucket) {
    functionCodeParams.S3Bucket = bucket
    functionCodeParams.S3Key = path.basename(zipPath)
  } else {
    functionCodeParams.ZipFile = await readFile(zipPath)
  }
  const res = await lambda.updateFunctionCode(functionCodeParams).promise()

  return res.FunctionArn
}

const getLambda = async ({ lambda, name }) => {
  try {
    const res = await lambda
      .getFunctionConfiguration({
        FunctionName: name
      })
      .promise()

    return {
      name: res.FunctionName,
      description: res.Description,
      timeout: res.Timeout,
      runtime: res.Runtime,
      role: {
        arn: res.Role
      },
      handler: res.Handler,
      memory: res.MemorySize,
      hash: res.CodeSha256,
      env: res.Environment ? res.Environment.Variables : {},
      arn: res.FunctionArn
    }
  } catch (e) {
    if (e.code === 'ResourceNotFoundException') {
      return null
    }
    throw e
  }
}

const deleteLambda = async ({ lambda, name }) => {
  try {
    const params = { FunctionName: name }
    await lambda.deleteFunction(params).promise()
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      throw error
    }
  }
}

const getPolicy = async ({ name, region, accountId }) => {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Action: ['logs:CreateLogStream'],
        Resource: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${name}:*`],
        Effect: 'Allow'
      },
      {
        Action: ['logs:PutLogEvents'],
        Resource: [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${name}:*:*`],
        Effect: 'Allow'
      }
    ]
  }
}

const configChanged = (prevLambda, lambda) => {
  const keys = ['description', 'runtime', 'role', 'handler', 'memory', 'timeout', 'env', 'hash']
  const inputs = pick(keys, lambda)
  const prevInputs = pick(keys, prevLambda)
  return not(equals(inputs, prevInputs))
}

const pack = async (code, shims = [], packDeps = true) => {
  if (utils.isArchivePath(code)) {
    return path.resolve(code)
  }

  let exclude = []

  if (!packDeps) {
    exclude = ['node_modules/**']
  }

  const outputFilePath = path.join(tmpdir(), `${Math.random().toString(36).substring(6)}.zip`)

  return packDir(code, outputFilePath, shims, exclude)
}

/**
 * Get the AWS credentials.
 *
 * @returns {Promise<Credentials | null | undefined>} credentials
 */
function getAwsCredentials() {
  return new Promise((resolve, reject) => {
    AWS.config.getCredentials(function (err) {
      if (err) {
        return reject(err)
      }

      resolve(AWS.config.credentials)
    })
  })
}

/**
 * Get AWS SDK Clients
 * @param {Credentials | null | undefined} credentials
 * @param {string} region
 */
const getClients = (credentials, region) => {
  // this error message assumes that the user is running via the CLI though...
  if (Object.keys(credentials).length === 0) {
    const msg = `Credentials not found. Make sure you have a .env file in the cwd. - Docs: https://git.io/JvArp`
    throw new Error(msg)
  }

  const iam = new AWS.IAM({ credentials, region })
  const lambda = new AWS.Lambda({ credentials, region })

  return { iam, lambda }
}

/**
 * Create an AWS IAM Role
 * @param {IAM} iam
 * @param {string} roleName
 */
const createRole = async (iam, roleName) => {
  const assumeRolePolicyDocument = {
    Version: '2012-10-17',
    Statement: {
      Effect: 'Allow',
      Principal: {
        Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com']
      },
      Action: 'sts:AssumeRole'
    }
  }

  const res = await iam
    .createRole({
      RoleName: roleName,
      Path: '/',
      AssumeRolePolicyDocument: JSON.stringify(assumeRolePolicyDocument)
    })
    .promise()

  await iam
    .attachRolePolicy({
      RoleName: roleName,
      PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
    })
    .promise()

  return res
}

/**
 * Get an AWS IAM Role
 * @param {IAM} iam
 * @param {string} roleName
 */
const getRole = async (iam, roleName) => {
  let res
  try {
    res = await iam
      .getRole({
        RoleName: roleName
      })
      .promise()
  } catch (error) {
    if (error.code && error.code === 'NoSuchEntity') {
      return
    }
    throw error
  }
  return res
}

/**
 * Remove AWS IAM Role
 * @param {IAM} iam
 * @param {string} roleArn
 */
const removeRole = async (iam, roleArn) => {
  try {
    await iam
      .detachRolePolicy({
        RoleName: roleArn.split('/')[1], // extract role name from arn
        PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
      })
      .promise()
    await iam
      .deleteRole({
        RoleName: roleArn.split('/')[1]
      })
      .promise()
  } catch (error) {
    if (error.code !== 'NoSuchEntity') {
      throw error
    }
  }
}

module.exports = {
  getAwsCredentials,
  getClients,
  createRole,
  getRole,
  removeRole,
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  getLambda,
  deleteLambda,
  getPolicy,
  getAccountId,
  configChanged,
  pack
}
