variable "REGISTRY" {
  default = "support-shield"
}
variable "SECONDARY_REGISTRY" {
  default = ""
}
variable "TAG" {
  default = "local"
}

group "default" {
  targets = ["gateway", "worker", "sandbox-runner"]
}

target "_common" {
  context = "."
  platforms = ["linux/amd64", "linux/arm64"]
  attest = ["type=sbom", "type=provenance,mode=max"]
}

target "gateway" {
  inherits = ["_common"]
  dockerfile = "docker/Dockerfile.gateway"
  target = "gateway"
  tags = concat(
    ["${REGISTRY}/gateway:${TAG}"],
    SECONDARY_REGISTRY != "" ? ["${SECONDARY_REGISTRY}/gateway:${TAG}"] : []
  )
}

target "worker" {
  inherits = ["_common"]
  dockerfile = "docker/Dockerfile.worker"
  target = "worker"
  tags = concat(
    ["${REGISTRY}/worker:${TAG}"],
    SECONDARY_REGISTRY != "" ? ["${SECONDARY_REGISTRY}/worker:${TAG}"] : []
  )
}

target "sandbox-runner" {
  inherits = ["_common"]
  dockerfile = "docker/Dockerfile.sandbox-runner"
  target = "sandbox-runner"
  tags = concat(
    ["${REGISTRY}/sandbox-runner:${TAG}"],
    SECONDARY_REGISTRY != "" ? ["${SECONDARY_REGISTRY}/sandbox-runner:${TAG}"] : [],
    TAG == "local" ? ["sandbox-runner:local"] : []
  )
}
