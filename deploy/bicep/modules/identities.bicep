param prefix string
param location string

resource gateway 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-gateway-mi'
  location: location
}
resource worker 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-worker-mi'
  location: location
}

output gatewayIdentityId string = gateway.id
output gatewayClientId string = gateway.properties.clientId
output gatewayPrincipalId string = gateway.properties.principalId
output workerIdentityId string = worker.id
output workerClientId string = worker.properties.clientId
output workerPrincipalId string = worker.properties.principalId
