param prefix string
param location string
param privateEndpointSubnetId string
param virtualNetworkId string

// Premium supports private endpoints. Review Azure Cache retirement before rollout.
resource redis 'Microsoft.Cache/redis@2024-11-01' = {
  name: '${prefix}-${uniqueString(resourceGroup().id)}-redis'
  location: location
  properties: {
    sku: { name: 'Premium', family: 'P', capacity: 1 }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    redisVersion: '6'
    redisConfiguration: { 'maxmemory-policy': 'noeviction' }
  }
}
resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.redis.cache.windows.net'
  location: 'global'
}
resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dns
  name: '${prefix}-redis-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: virtualNetworkId } }
}
resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-redis-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'redis'
        properties: { privateLinkServiceId: redis.id, groupIds: [ 'redisCache' ] }
      }
    ]
  }
}
resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [ { name: 'redis', properties: { privateDnsZoneId: dns.id } } ]
  }
}

output redisName string = redis.name
output redisHost string = redis.properties.hostName
