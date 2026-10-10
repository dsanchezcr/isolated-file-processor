using './main.bicep'

param prefix = 'support-shield'
param location = 'eastus'
// Environment values are resolved by the deployment runner, not stored here.
param gatewayImage = readEnvironmentVariable('GATEWAY_IMAGE')
param workerImage = readEnvironmentVariable('WORKER_IMAGE')
param apiKey = readEnvironmentVariable('API_KEY')
param workerDeploymentEnabled = false
param otlpEndpoint = readEnvironmentVariable('OTEL_EXPORTER_OTLP_ENDPOINT', '')
param acrName = readEnvironmentVariable('ACR_NAME', '')
