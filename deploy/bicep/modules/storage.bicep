param prefix string
param location string
param privateEndpointSubnetId string
param virtualNetworkId string
param gatewayPrincipalId string
param workerPrincipalId string

var contributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var readerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'ss${uniqueString(resourceGroup().id, prefix)}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None' }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: { blob: { enabled: true, keyType: 'Account' } }
    }
  }
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: false
    deleteRetentionPolicy: { enabled: false }
    containerDeleteRetentionPolicy: { enabled: false }
  }
}
resource quarantine 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'quarantine-files'
  properties: { publicAccess: 'None' }
}
resource clean 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'clean-files'
  properties: { publicAccess: 'None' }
}
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-quarantine-after-one-day'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: [ 'blockBlob' ], prefixMatch: [ 'quarantine-files/' ] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 1 } } }
          }
        }
      ]
    }
  }
}
resource gatewayQuarantineRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(quarantine.id, gatewayPrincipalId, contributorRoleId)
  scope: quarantine
  properties: {
    principalId: gatewayPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleId
  }
}
resource workerQuarantineRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(quarantine.id, workerPrincipalId, readerRoleId)
  scope: quarantine
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleId
  }
}
resource workerCleanRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(clean.id, workerPrincipalId, contributorRoleId)
  scope: clean
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleId
  }
}
resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
}
resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dns
  name: '${prefix}-blob-link'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: virtualNetworkId } }
}
resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-blob-pe'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: { privateLinkServiceId: storage.id, groupIds: [ 'blob' ] }
      }
    ]
  }
}
resource dnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [ { name: 'blob', properties: { privateDnsZoneId: dns.id } } ]
  }
}

output storageAccountName string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob
