targetScope = 'resourceGroup'

@description('Short, lowercase deployment name. Storage names are generated separately.')
@minLength(3)
@maxLength(18)
param prefix string = 'support-shield'
param location string = resourceGroup().location
@description('Publicly pullable gateway image, preferably pinned by digest.')
param gatewayImage string
@description('Worker image for the disabled ACA blueprint; not a supported Docker execution backend.')
param workerImage string
@secure()
@minLength(32)
param apiKey string
@description('EXPERIMENTAL blueprint only. The worker fails closed with SANDBOX_BACKEND=disabled. ACA cannot execute the Docker adapter.')
param workerDeploymentEnabled bool = false

module network './modules/network.bicep' = {
  name: 'network'
  params: { prefix: prefix, location: location }
}
module monitoring './modules/monitoring.bicep' = {
  name: 'monitoring'
  params: { prefix: prefix, location: location }
}
module identities './modules/identities.bicep' = {
  name: 'identities'
  params: { prefix: prefix, location: location }
}
module storage './modules/storage.bicep' = {
  name: 'storage'
  params: {
    prefix: prefix
    location: location
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    virtualNetworkId: network.outputs.virtualNetworkId
    gatewayPrincipalId: identities.outputs.gatewayPrincipalId
    workerPrincipalId: identities.outputs.workerPrincipalId
  }
}
module redis './modules/redis.bicep' = {
  name: 'redis'
  params: {
    prefix: prefix
    location: location
    privateEndpointSubnetId: network.outputs.privateEndpointSubnetId
    virtualNetworkId: network.outputs.virtualNetworkId
  }
}
module environment './modules/containerAppEnv.bicep' = {
  name: 'environment'
  params: {
    prefix: prefix
    location: location
    infrastructureSubnetId: network.outputs.infrastructureSubnetId
    workspaceId: monitoring.outputs.workspaceId
  }
}
module apps './modules/containerApps.bicep' = {
  name: 'apps'
  params: {
    prefix: prefix
    location: location
    environmentId: environment.outputs.environmentId
    gatewayImage: gatewayImage
    workerImage: workerImage
    apiKey: apiKey
    workerDeploymentEnabled: workerDeploymentEnabled
    gatewayIdentityId: identities.outputs.gatewayIdentityId
    gatewayClientId: identities.outputs.gatewayClientId
    workerIdentityId: identities.outputs.workerIdentityId
    workerClientId: identities.outputs.workerClientId
    storageAccountName: storage.outputs.storageAccountName
    redisName: redis.outputs.redisName
    redisHost: redis.outputs.redisHost
    appInsightsName: monitoring.outputs.appInsightsName
  }
}

output gatewayUrl string = apps.outputs.gatewayUrl
output storageAccountName string = storage.outputs.storageAccountName
output gatewayIdentityId string = identities.outputs.gatewayIdentityId
output workerIdentityId string = identities.outputs.workerIdentityId
output workerExecutionStatus string = workerDeploymentEnabled
  ? 'UNSUPPORTED BLUEPRINT: worker fails closed; no ACA Docker execution backend.'
  : 'BLOCKED: deploy a separately secured dedicated Docker execution host; ACA worker is not deployed.'
