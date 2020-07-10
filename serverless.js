const path = require('path')
const { mergeDeepRight, pick } = require('ramda')
const { Component, utils } = require('@serverless/core')
const {
  getClients,
  getRole,
  createRole,
  removeRole,
  createLambda,
  updateLambdaCode,
  updateLambdaConfig,
  getLambda,
  deleteLambda,
  configChanged,
  pack
} = require('./utils')

const outputsList = [
  'name',
  'hash',
  'description',
  'memory',
  'timeout',
  'code',
  'bucket',
  'shims',
  'handler',
  'runtime',
  'env',
  'role',
  'layer',
  'arn',
  'region'
]

const defaults = {
  name: undefined,
  description: 'AWS Lambda Component',
  memory: 512,
  timeout: 10,
  code: process.cwd(),
  bucket: undefined,
  roleArn: undefined,
  shims: [],
  handler: 'handler.hello',
  runtime: 'nodejs12.x',
  env: {},
  region: 'us-east-1'
}

class AwsLambda extends Component {
  async default(inputs = {}) {
    this.context.status(`Deploying`)

    const config = mergeDeepRight(defaults, inputs)

    config.name = config.name || this.state.name || this.context.resourceId()

    this.context.debug(
      `Starting deployment of lambda ${config.name} to the ${config.region} region.`
    )

    // Get AWS clients
    const { lambda, iam } = getClients(this.context.credentials.aws, config.region)

    // If no AWS IAM Role role exists, auto-create a default role
    if (!config.roleArn) {
      console.log(
        `No AWS IAM Role provided. Creating/Updating default IAM Role with basic execution rights.`
      )
      const iamRoleName = `${inputs.name}-role`
      let res = await getRole(iam, iamRoleName)
      if (res) {
        config.autoRoleArn = this.state.autoRoleArn = res.Role.Arn
      } else {
        res = await createRole(iam, iamRoleName)
      }
      config.autoRoleArn = this.state.autoRoleArn = res.Role.Arn
    }

    // If user has put in a custom AWS IAM Role and an auto-created role exists, delete the auto-created role
    if (config.roleArn && this.state.autoRoleArn) {
      console.log('Detected a new roleArn has been provided.  Removing the auto-created role...')
      await removeRole(iam, this.state.autoRoleArn)
    }

    if (
      config.bucket &&
      config.runtime === 'nodejs10.x' &&
      (await utils.dirExists(path.join(config.code, 'node_modules')))
    ) {
      this.context.debug(`Bucket ${config.bucket} is provided for lambda ${config.name}.`)

      const layer = await this.load('@serverless/aws-lambda-layer')

      const layerInputs = {
        description: `${config.name} Dependencies Layer`,
        code: path.join(config.code, 'node_modules'),
        runtimes: ['nodejs10.x'],
        prefix: 'nodejs/node_modules',
        bucket: config.bucket,
        region: config.region
      }

      this.context.status('Deploying Dependencies')
      this.context.debug(`Packaging lambda code from ${config.code}.`)
      this.context.debug(`Uploading dependencies as a layer for lambda ${config.name}.`)

      const promises = [pack(config.code, config.shims, false), layer(layerInputs)]
      const res = await Promise.all(promises)
      config.zipPath = res[0]
      config.layer = res[1]
    } else {
      this.context.status('Packaging')
      this.context.debug(`Packaging lambda code from ${config.code}.`)
      config.zipPath = await pack(config.code, config.shims)
    }

    config.hash = await utils.hashFile(config.zipPath)

    let deploymentBucket
    if (config.bucket) {
      deploymentBucket = await this.load('@serverless/aws-s3')
    }

    const prevLambda = await getLambda({ lambda, ...config })

    if (!prevLambda) {
      if (config.bucket) {
        this.context.debug(`Uploading ${config.name} lambda package to bucket ${config.bucket}.`)
        this.context.status(`Uploading`)

        await deploymentBucket.upload({ name: config.bucket, file: config.zipPath })
      }

      this.context.status(`Creating`)
      this.context.debug(`Creating lambda ${config.name} in the ${config.region} region.`)

      const createResult = await createLambda({ lambda, ...config })
      config.arn = createResult.arn
      config.hash = createResult.hash
    } else {
      config.arn = prevLambda.arn

      if (configChanged(prevLambda, config)) {
        if (config.bucket && prevLambda.hash !== config.hash) {
          this.context.status(`Uploading code`)
          this.context.debug(`Uploading ${config.name} lambda code to bucket ${config.bucket}.`)

          await deploymentBucket.upload({ name: config.bucket, file: config.zipPath })
          await updateLambdaCode({ lambda, ...config })
        } else if (!config.bucket && prevLambda.hash !== config.hash) {
          this.context.status(`Uploading code`)
          this.context.debug(`Uploading ${config.name} lambda code.`)
          await updateLambdaCode({ lambda, ...config })
        }

        this.context.status(`Updating`)
        this.context.debug(`Updating ${config.name} lambda config.`)

        const updateResult = await updateLambdaConfig({ lambda, ...config })
        config.hash = updateResult.hash
      }
    }

    // todo we probably don't need this logic now thatt we auto generate names
    if (this.state.name && this.state.name !== config.name) {
      this.context.status(`Replacing`)
      await deleteLambda({ lambda, name: this.state.name })
    }

    this.context.debug(
      `Successfully deployed lambda ${config.name} in the ${config.region} region.`
    )

    const outputs = pick(outputsList, config)

    this.state = outputs
    await this.save()

    return outputs
  }

  async publishVersion() {
    const { name, region, hash } = this.state

    const { lambda } = getClients(this.context.credentials.aws, region)

    const { Version } = await lambda
      .publishVersion({
        FunctionName: name,
        CodeSha256: hash
      })
      .promise()

    return { version: Version }
  }

  async remove() {
    this.context.status(`Removing`)

    if (!this.state.name) {
      this.context.debug(`Aborting removal. Function name not found in state.`)
      return
    }

    const { name, region } = this.state

    const { lambda } = getClients(this.context.credentials.aws, region)
    const awsIamRole = await this.load('@serverless/aws-iam-role')
    const layer = await this.load('@serverless/aws-lambda-layer')

    await awsIamRole.remove()
    await layer.remove()

    this.context.debug(`Removing lambda ${name} from the ${region} region.`)
    await deleteLambda({ lambda, name })
    this.context.debug(`Successfully removed lambda ${name} from the ${region} region.`)

    const outputs = pick(outputsList, this.state)

    this.state = {}
    await this.save()

    return outputs
  }
}

module.exports = AwsLambda
