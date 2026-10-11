/** Closed stock authority wire contracts. Structural endpoint bounds are followed by the
 * native endpointToken grammar, never an ambient URI or unsafe nested-regex validator. */
import { compileContract } from "./schema-profile.js";
const definitions = {
  "account": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "space": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "accountPublicKey": {
        "type": "string",
        "pattern": "^A[A-Z2-7]{55}$"
      },
      "assignmentRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "space",
      "accountPublicKey",
      "assignmentRevision"
    ]
  },
  "admissionRequest": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "v": {
        "const": 2
      },
      "operation": {
        "const": "admit"
      },
      "operationId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "serving": {
        "$ref": "#/definitions/servingPin"
      },
      "requestSubject": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      },
      "request": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_-]{1,64}$"
          },
          "envelopeDigest": {
            "type": "string",
            "pattern": "^sha256:[a-f0-9]{64}$"
          }
        },
        "required": [
          "id",
          "envelopeDigest"
        ]
      }
    },
    "required": [
      "v",
      "operation",
      "operationId",
      "serving",
      "requestSubject",
      "request"
    ]
  },
  "admissionResponse": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "v": {
        "const": 2
      },
      "operation": {
        "const": "admit"
      },
      "operationId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "admissionId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "serving": {
        "$ref": "#/definitions/servingPin"
      },
      "caller": {
        "$ref": "#/definitions/issuedRef"
      },
      "requestSubjectDigest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      },
      "envelopeDigest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      },
      "commands": {
        "type": "array",
        "maxItems": 64,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "pattern": "^[a-z0-9-]{1,32}$"
        }
      }
    },
    "required": [
      "v",
      "operation",
      "operationId",
      "admissionId",
      "serving",
      "caller",
      "requestSubjectDigest",
      "envelopeDigest",
      "commands"
    ]
  },
  "authority": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "policyRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "namespaceRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "delegationId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "delegationRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "policyRevision",
      "namespaceRevision",
      "delegationId",
      "delegationRevision"
    ]
  },
  "ceiling": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "routes": {
        "$ref": "#/definitions/routes"
      },
      "resources": {
        "$ref": "#/definitions/resources"
      },
      "expiresAt": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "routes",
      "resources",
      "expiresAt"
    ]
  },
  "holder": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "owner": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{1,64}$"
      },
      "actor": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{1,64}$"
      },
      "lifecycleUid": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "publicKey": {
        "type": "string",
        "pattern": "^U[A-Z2-7]{55}$"
      }
    },
    "required": [
      "owner",
      "actor",
      "lifecycleUid",
      "publicKey"
    ]
  },
  "issuedRef": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "space": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "owner": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{1,64}$"
      },
      "actor": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{1,64}$"
      },
      "uid": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "generation": {
        "type": "string",
        "pattern": "^[a-f0-9]{32}$"
      }
    },
    "required": [
      "space",
      "owner",
      "actor",
      "uid",
      "generation"
    ]
  },
  "releaseRequest": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "v": {
        "const": 2
      },
      "operation": {
        "const": "release"
      },
      "operationId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "admissionId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "serving": {
        "$ref": "#/definitions/servingPin"
      },
      "outcome": {
        "enum": [
          "executed",
          "not-executed",
          "unknown"
        ]
      }
    },
    "required": [
      "v",
      "operation",
      "operationId",
      "admissionId",
      "serving",
      "outcome"
    ]
  },
  "releaseResponse": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "v": {
        "const": 2
      },
      "operation": {
        "const": "release"
      },
      "admissionId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "released": {
        "const": true
      },
      "outcome": {
        "enum": [
          "executed",
          "not-executed",
          "unknown"
        ]
      }
    },
    "required": [
      "v",
      "operation",
      "admissionId",
      "released",
      "outcome"
    ]
  },
  "resources": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "kind": {
        "const": "ephemeral-only"
      }
    },
    "required": [
      "kind"
    ]
  },
  "routes": {
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": {
            "const": "instance"
          }
        },
        "required": [
          "kind"
        ]
      },
      {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "kind": {
            "const": "class"
          },
          "classRevision": {
            "type": "integer",
            "minimum": 1,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "kind",
          "classRevision"
        ]
      }
    ]
  },
  "serveAttestation": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "v": {
        "const": 2
      },
      "kind": {
        "const": "cotal.endpoint-serve"
      },
      "issuer": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      },
      "account": {
        "$ref": "#/definitions/account"
      },
      "endpoint": {
        "type": "string",
        "pattern": "^[a-z0-9.-]{1,64}$",
        "maxLength": 64
      },
      "instanceId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "operationId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "holder": {
        "$ref": "#/definitions/holder"
      },
      "authority": {
        "$ref": "#/definitions/authority"
      },
      "protocol": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "v": {
            "const": 3
          }
        },
        "required": [
          "v"
        ]
      },
      "registrationRevision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "processEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "clusterDigests": {
        "type": "array",
        "minItems": 1,
        "maxItems": 64,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "pattern": "^sha256:[a-f0-9]{64}$"
        }
      },
      "ceiling": {
        "$ref": "#/definitions/ceiling"
      },
      "credentialId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "credentialDigest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      },
      "issuedAt": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "expiresAt": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      }
    },
    "required": [
      "v",
      "kind",
      "issuer",
      "account",
      "endpoint",
      "instanceId",
      "operationId",
      "holder",
      "authority",
      "protocol",
      "registrationRevision",
      "processEpoch",
      "clusterDigests",
      "ceiling",
      "credentialId",
      "credentialDigest",
      "issuedAt",
      "expiresAt"
    ]
  },
  "servingPin": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "account": {
        "$ref": "#/definitions/account"
      },
      "endpoint": {
        "type": "string",
        "pattern": "^[a-z0-9.-]{1,64}$",
        "maxLength": 64
      },
      "instanceId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "epoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "authority": {
        "$ref": "#/definitions/authority"
      }
    },
    "required": [
      "account",
      "endpoint",
      "instanceId",
      "epoch",
      "authority"
    ]
  },
  "checkRequest": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "v": {
        "const": 2
      },
      "endpoint": {
        "type": "string",
        "pattern": "^[a-z0-9.-]{1,64}$"
      },
      "instanceId": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "credentialDigest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      },
      "nonce": {
        "type": "string",
        "pattern": "^[a-z0-9]{26,32}$"
      },
      "signature": {
        "type": "string",
        "pattern": "^[A-Za-z0-9_-]{86}$"
      }
    },
    "required": [
      "v",
      "endpoint",
      "instanceId",
      "credentialDigest",
      "nonce",
      "signature"
    ]
  },
  "checkResponse": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "current": {
        "const": true
      },
      "credentialDigest": {
        "type": "string",
        "pattern": "^sha256:[a-f0-9]{64}$"
      }
    },
    "required": [
      "current",
      "credentialDigest"
    ]
  }
} as const;
export const ENDPOINT_AUTHORITY_INPUT_SCHEMA = { definitions, oneOf: [ { $ref: "#/definitions/admissionRequest" }, { $ref: "#/definitions/releaseRequest" }, { $ref: "#/definitions/checkRequest" } ] } as const;
export const ENDPOINT_AUTHORITY_OUTPUT_SCHEMA = { definitions, oneOf: [ { $ref: "#/definitions/admissionResponse" }, { $ref: "#/definitions/releaseResponse" }, { $ref: "#/definitions/checkResponse" } ] } as const;
export const endpointServeAttestationContract = compileContract({ root: { definitions, $ref: "#/definitions/serveAttestation" } });
