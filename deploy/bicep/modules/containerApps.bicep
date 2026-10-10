param prefix string
param location string
param environmentId string
param gatewayImage string
param workerImage string
@secure()
param apiKey string
param workerDeploymentEnabled bool
param gatewayIdentityId string
param gatewayClientId string
param gatewayPrincipalId string
param workerIdentityId string
param workerClientId string
param workerPrincipalId string
param storageAccountName string
param redisName string
param redisHost string
param appInsightsName string
param otlpEndpoint string
param acrName string

resource redis 'Microsoft.Cache/redis@2024-11-01' existing = { name: redisName }
resource insights 'Microsoft.Insights/components@2020-02-02' existing = { name: appInsightsName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = if (!empty(acrName)) {
  name: acrName
}
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
resource gatewayRegistryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(acrName)) {
  name: guid(registry!.id, gatewayPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    principalId: gatewayPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}
resource workerRegistryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(acrName)) {
  name: guid(registry!.id, workerPrincipalId, acrPullRoleId)
  scope: registry
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}

var sharedEnvironment = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'STORAGE_BACKEND', value: 'azure' }
  { name: 'AZURE_STORAGE_ACCOUNT', value: storageAccountName }
  { name: 'REDIS_URL', secretRef: 'redis-url' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'app-insights' }
  { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: otlpEndpoint }
]
var secrets = [
  { name: 'redis-password', value: redis.listKeys().primaryKey }
  { name: 'redis-url', value: 'rediss://:${uriComponent(redis.listKeys().primaryKey)}@${redisHost}:6380' }
  { name: 'app-insights', value: insights.properties.ConnectionString }
]

resource gateway 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-gateway'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${gatewayIdentityId}': {} } }
  properties: {
    managedEnvironmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: concat(secrets, [ { name: 'api-key', value: apiKey } ])
      registries: empty(acrName) ? [] : [
        { server: registry!.properties.loginServer, identity: gatewayIdentityId }
      ]
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
      }
    }
    template: {
      containers: [
        {
          name: 'gateway'
          image: gatewayImage
          env: concat(sharedEnvironment, [
            { name: 'AZURE_CLIENT_ID', value: gatewayClientId }
            { name: 'API_KEY', secretRef: 'api-key' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '3000' }
          ])
          resources: { cpu: json('0.5'), memory: '1Gi' }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 10
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '20' } } }
        ]
      }
    }
  }
  dependsOn: [ gatewayRegistryPull ]
}

// A scaling design blueprint, NOT a working Docker worker deployment.
resource worker 'Microsoft.App/containerApps@2024-03-01' = if (workerDeploymentEnabled) {
  name: '${prefix}-worker-blueprint'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${workerIdentityId}': {} } }
  properties: {
    managedEnvironmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: secrets
      registries: empty(acrName) ? [] : [
        { server: registry!.properties.loginServer, identity: workerIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: workerImage
          env: concat(sharedEnvironment, [
            { name: 'AZURE_CLIENT_ID', value: workerClientId }
            { name: 'SANDBOX_BACKEND', value: 'disabled' }
          ])
          resources: { cpu: 1, memory: '2Gi' }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 10
        rules: [
          {
            name: 'bullmq-waiting'
            custom: {
              type: 'redis'
              metadata: {
                address: '${redisHost}:6380'
                listName: 'bull:attachments:wait'
                listLength: '1'
                enableTLS: 'true'
              }
              auth: [ { secretRef: 'redis-password', triggerParameter: 'password' } ]
            }
          }
        ]
      }
    }
  }
  dependsOn: [ workerRegistryPull ]
}

output gatewayUrl string = 'https://${gateway.properties.configuration.ingress.fqdn}'
