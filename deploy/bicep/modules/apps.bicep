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
param workerIdentityId string
param workerClientId string
param storageAccountName string
param redisName string
param redisHost string
param appInsightsName string

resource redis 'Microsoft.Cache/redis@2024-11-01' existing = { name: redisName }
resource insights 'Microsoft.Insights/components@2020-02-02' existing = { name: appInsightsName }

var sharedEnvironment = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'STORAGE_BACKEND', value: 'azure' }
  { name: 'AZURE_STORAGE_ACCOUNT', value: storageAccountName }
  { name: 'REDIS_URL', secretRef: 'redis-url' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', secretRef: 'app-insights' }
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
        maxReplicas: 3
        rules: [
          { name: 'http', http: { metadata: { concurrentRequests: '20' } } }
        ]
      }
    }
  }
}

// A scaling design blueprint, NOT a working Docker worker deployment.
resource worker 'Microsoft.App/containerApps@2024-03-01' = if (workerDeploymentEnabled) {
  name: '${prefix}-worker-blueprint'
  location: location
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${workerIdentityId}': {} } }
  properties: {
    managedEnvironmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: { activeRevisionsMode: 'Single', secrets: secrets }
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
        maxReplicas: 5
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
}

output gatewayUrl string = 'https://${gateway.properties.configuration.ingress.fqdn}'
