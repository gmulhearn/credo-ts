import type { AgentContext } from '../../agent'

import { DcqlCredentialRepresentation, DcqlMdocRepresentation, DcqlQuery, DcqlSdJwtVcRepresentation } from 'dcql'
import { injectable } from 'tsyringe'

import { JsonValue } from '../../types'
import { Mdoc, MdocApi, MdocDeviceResponse, MdocOpenId4VpSessionTranscriptOptions, MdocRecord } from '../mdoc'
import { IPresentationFrame, SdJwtVcApi, SdJwtVcRecord } from '../sd-jwt-vc'
import {
  ClaimFormat,
  W3cCredentialRecord,
  W3cCredentialRepository,
  W3cJsonLdVerifiablePresentation,
  W3cJwtVerifiablePresentation,
} from '../vc'

import { DcqlError } from './DcqlError'
import { DcqlQueryResult, DcqlCredentialsForRequest, DcqlPresentationRecord } from './models'
import { dcqlGetPresentationsToCreate } from './utils'

/**
 * @todo create a public api for using dif presentation exchange
 */
@injectable()
export class DcqlService {
  /**
   * Queries the wallet for credentials that match the given presentation definition. This only does an initial query based on the
   * schema of the input descriptors. It does not do any further filtering based on the constraints in the input descriptors.
   */
  private async queryCredentialForPresentationDefinition(
    agentContext: AgentContext,
    dcqlQuery: DcqlQuery
  ): Promise<Array<SdJwtVcRecord | W3cCredentialRecord | MdocRecord>> {
    const w3cCredentialRepository = agentContext.dependencyManager.resolve(W3cCredentialRepository)

    const formats = new Set(dcqlQuery.credentials.map((c) => c.format))
    for (const format of formats) {
      if (format !== 'vc+sd-jwt' && format !== 'jwt_vc_json' && format !== 'jwt_vc_json-ld' && format !== 'mso_mdoc') {
        throw new DcqlError(`Unsupported credential format ${format}.`)
      }
    }

    const allRecords: Array<SdJwtVcRecord | W3cCredentialRecord | MdocRecord> = []

    // query the wallet ourselves first to avoid the need to query the pex library for all
    // credentials for every proof request
    const w3cCredentialRecords =
      formats.has('jwt_vc_json') || formats.has('jwt_vc_json-ld')
        ? await w3cCredentialRepository.getAll(agentContext)
        : []
    allRecords.push(...w3cCredentialRecords)

    const sdJwtVcApi = this.getSdJwtVcApi(agentContext)
    const sdJwtVcRecords = formats.has('vc+sd-jwt') ? await sdJwtVcApi.getAll() : []
    allRecords.push(...sdJwtVcRecords)

    const mdocApi = this.getMdocApi(agentContext)
    const mdocRecords = formats.has('mso_mdoc') ? await mdocApi.getAll() : []
    allRecords.push(...mdocRecords)

    return allRecords
  }

  public async getCredentialsForRequest(agentContext: AgentContext, dcqlQuery: DcqlQuery): Promise<DcqlQueryResult> {
    const credentialRecords = await this.queryCredentialForPresentationDefinition(agentContext, dcqlQuery)

    const mappedCredentials: DcqlCredentialRepresentation[] = credentialRecords.map((record) => {
      if (record.type === 'MdocRecord') {
        return {
          docType: record.getTags().docType,
          namespaces: Mdoc.fromBase64Url(record.base64Url).issuerSignedNamespaces,
        } satisfies DcqlMdocRepresentation
      } else if (record.type === 'SdJwtVcRecord') {
        return {
          vct: record.getTags().vct,
          claims: this.getSdJwtVcApi(agentContext).fromCompact(record.compactSdJwtVc)
            .prettyClaims as DcqlSdJwtVcRepresentation.Claims,
        } satisfies DcqlSdJwtVcRepresentation
      } else {
        // TODO:
        throw new DcqlError('W3C credentials are not supported yet')
      }
    })

    const queryResult = DcqlQuery.query(dcqlQuery, mappedCredentials)
    const matchesWithRecord = Object.fromEntries(
      Object.entries(queryResult.credential_matches).map(([credential_query_id, result]) => {
        return [credential_query_id, { ...result, record: credentialRecords[result.credential_index] }]
      })
    )

    return {
      ...queryResult,
      credential_matches: matchesWithRecord,
    }
  }

  /**
   * Selects the credentials to use based on the output from `getCredentialsForRequest`
   * Use this method if you don't want to manually select the credentials yourself.
   */
  public selectCredentialsForRequest(dcqlQueryResult: DcqlQueryResult): DcqlCredentialsForRequest {
    if (!dcqlQueryResult.canBeSatisfied) {
      throw new DcqlError(
        'Cannot select the credentials for the dcql query presentation if the request cannot be satisfied'
      )
    }

    const credentials: DcqlCredentialsForRequest = {}

    if (dcqlQueryResult.credential_sets) {
      for (const credentialSet of dcqlQueryResult.credential_sets) {
        // undefined defaults to true
        if (credentialSet.required === false) continue
        const firstFullFillableOption = credentialSet.options.find((option) =>
          option.every((credential_id) => dcqlQueryResult.credential_matches[credential_id].success)
        )

        if (!firstFullFillableOption) {
          throw new DcqlError('Invalid dcql query result. No option is fullfillable')
        }

        for (const credentialQueryId of firstFullFillableOption) {
          const credential = dcqlQueryResult.credential_matches[credentialQueryId]

          if (credential.success && credential.record.type === 'MdocRecord' && 'namespaces' in credential.output) {
            credentials[credentialQueryId] = {
              credentialRecord: credential.record,
              disclosedPayload: credential.output.namespaces,
            }
          } else if (credential.success && credential.record.type !== 'MdocRecord' && 'claims' in credential.output) {
            credentials[credentialQueryId] = {
              credentialRecord: credential.record,
              disclosedPayload: credential.output.claims,
            }
          } else {
            throw new DcqlError('Invalid dcql query result. Cannot auto-select credentials')
          }
        }
      }
    } else {
      for (const credentialQuery of dcqlQueryResult.credentials) {
        const credential = dcqlQueryResult.credential_matches[credentialQuery.id]
        if (credential.success && credential.record.type === 'MdocRecord' && 'namespaces' in credential.output) {
          credentials[credentialQuery.id] = {
            credentialRecord: credential.record,
            disclosedPayload: credential.output.namespaces,
          }
        } else if (credential.success && credential.record.type !== 'MdocRecord' && 'claims' in credential.output) {
          credentials[credentialQuery.id] = {
            credentialRecord: credential.record,
            disclosedPayload: credential.output.claims,
          }
        } else {
          throw new DcqlError('Invalid dcql query result. Cannot auto-select credentials')
        }
      }
    }

    return credentials
  }

  public validateDcqlQuery(dcqlQuery: DcqlQuery.Input | DcqlQuery) {
    return DcqlQuery.parse(dcqlQuery)
  }

  // TODO: this IS WRONG
  private createPresentationFrame(obj: Record<string, JsonValue>): IPresentationFrame {
    const frame: IPresentationFrame = {}

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null) {
        frame[key] = true
      } else {
        frame[key] = !!value
      }
    }

    return frame
  }

  public async createPresentationRecord(
    agentContext: AgentContext,
    options: {
      credentialQueryToCredential: DcqlCredentialsForRequest
      challenge: string
      domain?: string
      openid4vp?: Omit<MdocOpenId4VpSessionTranscriptOptions, 'verifierGeneratedNonce' | 'clientId'>
    }
  ): Promise<DcqlPresentationRecord> {
    const { domain, challenge, openid4vp } = options

    const presentationRecord: DcqlPresentationRecord = {}

    const presentationsToCreate = dcqlGetPresentationsToCreate(options.credentialQueryToCredential)
    for (const [credentialQueryId, presentationToCreate] of Object.entries(presentationsToCreate)) {
      if (presentationToCreate.claimFormat === ClaimFormat.MsoMdoc) {
        const mdocRecord = presentationToCreate.credentialRecord
        if (!openid4vp) {
          throw new DcqlError('Missing openid4vp options for creating MDOC presentation.')
        }

        if (!domain) {
          throw new DcqlError('Missing domain property for creating MDOC presentation.')
        }

        const { deviceResponseBase64Url } = await MdocDeviceResponse.createOpenId4VpDcqlDeviceResponse(agentContext, {
          mdoc: Mdoc.fromBase64Url(mdocRecord.base64Url),
          docRequest: {
            itemsRequestData: {
              docType: mdocRecord.getTags().docType,
              nameSpaces: Object.fromEntries(
                Object.entries(presentationToCreate.disclosedPayload).map(([key, value]) => {
                  return [key, Object.fromEntries(Object.entries(value).map(([key]) => [key, true]))]
                })
              ),
            },
          },
          sessionTranscriptOptions: {
            ...openid4vp,
            clientId: domain,
            verifierGeneratedNonce: challenge,
          },
        })

        presentationRecord[credentialQueryId] = MdocDeviceResponse.fromBase64Url(deviceResponseBase64Url)
      } else if (presentationToCreate.claimFormat === ClaimFormat.SdJwtVc) {
        const presentationFrame = this.createPresentationFrame(presentationToCreate.disclosedPayload)

        if (!domain) {
          throw new DcqlError('Missing domain property for creating SdJwtVc presentation.')
        }

        const sdJwtVcApi = this.getSdJwtVcApi(agentContext)
        const presentation = await sdJwtVcApi.present({
          compactSdJwtVc: presentationToCreate.credentialRecord.compactSdJwtVc,
          presentationFrame,
          verifierMetadata: {
            audience: domain,
            nonce: challenge,
            issuedAt: Math.floor(Date.now() / 1000),
          },
        })

        presentationRecord[credentialQueryId] = sdJwtVcApi.fromCompact(presentation)
      } else {
        throw new DcqlError('Only MDOC presentations are supported')
      }
    }

    return presentationRecord
  }

  public async getEncodedPresentationRecord(presentationRecord: DcqlPresentationRecord) {
    return Object.fromEntries(
      Object.entries(presentationRecord).map(([key, value]) => {
        if (value instanceof MdocDeviceResponse) {
          return [key, value.base64Url]
        } else if (value instanceof W3cJsonLdVerifiablePresentation) {
          return [key, value.toJson()]
        } else if (value instanceof W3cJwtVerifiablePresentation) {
          return [key, value.encoded]
        } else {
          return [key, value.compact]
        }
      })
    )
  }

  private getSdJwtVcApi(agentContext: AgentContext) {
    return agentContext.dependencyManager.resolve(SdJwtVcApi)
  }

  private getMdocApi(agentContext: AgentContext) {
    return agentContext.dependencyManager.resolve(MdocApi)
  }
}
