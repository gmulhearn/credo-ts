import type {
  OpenId4VciCreateCredentialResponseOptions,
  OpenId4VciCreateCredentialOfferOptions,
  OpenId4VciCreateIssuerOptions,
  OpenId4VciPreAuthorizedCodeFlowConfig,
  OpenId4VciSignW3cCredentials,
  OpenId4VciAuthorizationCodeFlowConfig,
} from './OpenId4VcIssuerServiceOptions'
import type { OpenId4VcCredentialHolderBindingWithKey, OpenId4VciMetadata } from '../shared'
import type { AgentContext, Query, QueryOptions } from '@credo-ts/core'

import {
  AuthorizationServerMetadata,
  JwtSigner,
  Oauth2AuthorizationServer,
  Oauth2Client,
  Oauth2ErrorCodes,
  Oauth2ResourceServer,
  Oauth2ServerErrorResponseError,
  PkceCodeChallengeMethod,
  preAuthorizedCodeGrantIdentifier,
} from '@animo-id/oauth2'
import {
  CredentialIssuerMetadata,
  CredentialRequestFormatSpecific,
  getCredentialConfigurationsMatchingRequestFormat,
  Oid4vciDraftVersion,
  Oid4vciIssuer,
} from '@animo-id/oid4vci'
import {
  SdJwtVcApi,
  CredoError,
  ClaimFormat,
  getJwkFromJson,
  getJwkFromKey,
  injectable,
  joinUriParts,
  JwsService,
  KeyType,
  utils,
  W3cCredentialService,
  MdocApi,
  Key,
  JwtPayload,
  Jwt,
  EventEmitter,
} from '@credo-ts/core'

import { OpenId4VciCredentialFormatProfile } from '../shared'
import { dynamicOid4vciClientAuthentication, getOid4vciCallbacks } from '../shared/callbacks'
import { getOfferedCredentials } from '../shared/issuerMetadataUtils'
import { storeActorIdForContextCorrelationId } from '../shared/router'
import { addSecondsToDate, dateToSeconds, getKeyFromDid, getProofTypeFromKey } from '../shared/utils'

import { OpenId4VcIssuanceSessionState } from './OpenId4VcIssuanceSessionState'
import { OpenId4VcIssuanceSessionStateChangedEvent, OpenId4VcIssuerEvents } from './OpenId4VcIssuerEvents'
import { OpenId4VcIssuerModuleConfig } from './OpenId4VcIssuerModuleConfig'
import {
  OpenId4VcIssuerRepository,
  OpenId4VcIssuerRecord,
  OpenId4VcIssuanceSessionRepository,
  OpenId4VcIssuanceSessionRecord,
} from './repository'
import { generateTxCode } from './util/txCode'

/**
 * @internal
 */
@injectable()
export class OpenId4VcIssuerService {
  private w3cCredentialService: W3cCredentialService
  private openId4VcIssuerConfig: OpenId4VcIssuerModuleConfig
  private openId4VcIssuerRepository: OpenId4VcIssuerRepository
  private openId4VcIssuanceSessionRepository: OpenId4VcIssuanceSessionRepository

  public constructor(
    w3cCredentialService: W3cCredentialService,
    openId4VcIssuerConfig: OpenId4VcIssuerModuleConfig,
    openId4VcIssuerRepository: OpenId4VcIssuerRepository,
    openId4VcIssuanceSessionRepository: OpenId4VcIssuanceSessionRepository
  ) {
    this.w3cCredentialService = w3cCredentialService
    this.openId4VcIssuerConfig = openId4VcIssuerConfig
    this.openId4VcIssuerRepository = openId4VcIssuerRepository
    this.openId4VcIssuanceSessionRepository = openId4VcIssuanceSessionRepository
  }

  public async createCredentialOffer(
    agentContext: AgentContext,
    options: OpenId4VciCreateCredentialOfferOptions & { issuer: OpenId4VcIssuerRecord }
  ) {
    const {
      preAuthorizedCodeFlowConfig,
      authorizationCodeFlowConfig,
      issuer,
      offeredCredentials,
      version = 'v1.draft11-13',
    } = options
    if (!preAuthorizedCodeFlowConfig && !authorizationCodeFlowConfig) {
      throw new CredoError('Authorization Config or Pre-Authorized Config must be provided.')
    }

    const vcIssuer = this.getIssuer(agentContext)
    const issuerMetadata = await this.getIssuerMetadata(agentContext, issuer)

    const uniqueOfferedCredentials = Array.from(new Set(options.offeredCredentials))
    if (uniqueOfferedCredentials.length !== offeredCredentials.length) {
      throw new CredoError('All offered credentials must have unique ids.')
    }

    // We always use shortened URIs currently
    const hostedCredentialOfferUri = joinUriParts(issuerMetadata.credentialIssuer.credential_issuer, [
      this.openId4VcIssuerConfig.credentialOfferEndpoint.endpointPath,
      // It doesn't really matter what the url is, as long as it's unique
      utils.uuid(),
    ])

    const grants = await this.getGrantsFromConfig(agentContext, {
      preAuthorizedCodeFlowConfig,
      authorizationCodeFlowConfig,
    })

    const { credentialOffer, credentialOfferObject } = await vcIssuer.createCredentialOffer({
      credentialConfigurationIds: options.offeredCredentials,
      grants,
      credentialOfferUri: hostedCredentialOfferUri,
      credentialOfferScheme: options.baseUri,
      issuerMetadata: {
        originalDraftVersion: version === 'v1.draft11-13' ? Oid4vciDraftVersion.Draft11 : Oid4vciDraftVersion.Draft14,
        ...issuerMetadata,
      },
    })

    const issuanceSessionRepository = this.openId4VcIssuanceSessionRepository
    const issuanceSession = new OpenId4VcIssuanceSessionRecord({
      credentialOfferPayload: credentialOfferObject,
      credentialOfferUri: hostedCredentialOfferUri,
      issuerId: issuer.issuerId,
      state: OpenId4VcIssuanceSessionState.OfferCreated,
      authorization: {
        issuerState: credentialOfferObject.grants?.authorization_code?.issuer_state,
      },
      preAuthorizedCode: credentialOfferObject.grants?.[preAuthorizedCodeGrantIdentifier]?.['pre-authorized_code'],
      userPin: preAuthorizedCodeFlowConfig?.txCode
        ? generateTxCode(agentContext, preAuthorizedCodeFlowConfig.txCode)
        : undefined,
      issuanceMetadata: options.issuanceMetadata,
    })
    await issuanceSessionRepository.save(agentContext, issuanceSession)
    this.emitStateChangedEvent(agentContext, issuanceSession, null)

    return {
      issuanceSession,
      credentialOffer,
    }
  }

  public async createCredentialResponse(
    agentContext: AgentContext,
    options: OpenId4VciCreateCredentialResponseOptions & { issuanceSession: OpenId4VcIssuanceSessionRecord }
  ) {
    options.issuanceSession.assertState([
      // OfferUriRetrieved is valid when doing auth flow (we should add a check)
      OpenId4VcIssuanceSessionState.OfferUriRetrieved,
      OpenId4VcIssuanceSessionState.AccessTokenCreated,
      OpenId4VcIssuanceSessionState.CredentialRequestReceived,
      // It is possible to issue multiple credentials in one session
      OpenId4VcIssuanceSessionState.CredentialsPartiallyIssued,
    ])
    const { issuanceSession } = options
    const issuer = await this.getIssuerByIssuerId(agentContext, options.issuanceSession.issuerId)
    const vcIssuer = this.getIssuer(agentContext)
    const issuerMetadata = await this.getIssuerMetadata(agentContext, issuer)

    const parsedCredentialRequest = vcIssuer.parseCredentialRequest({
      credentialRequest: options.credentialRequest,
    })
    const { credentialRequest, credentialIdentifier, format, proofs } = parsedCredentialRequest
    if (credentialIdentifier) {
      throw new Oauth2ServerErrorResponseError({
        error: Oauth2ErrorCodes.InvalidCredentialRequest,
        error_description: `Using unsupported 'credential_identifier'`,
      })
    }

    if (!format) {
      throw new Oauth2ServerErrorResponseError({
        error: Oauth2ErrorCodes.UnsupportedCredentialFormat,
        error_description: `Unsupported credential format '${credentialRequest.format}'`,
      })
    }

    if (!proofs?.jwt || proofs.jwt.length === 0) {
      const { cNonce, cNonceExpiresInSeconds } = await this.createNonce(agentContext, issuer)
      throw new Oauth2ServerErrorResponseError({
        error: Oauth2ErrorCodes.InvalidProof,
        error_description: 'Missing required proof(s) in credential request',
        c_nonce: cNonce,
        c_nonce_expires_in: cNonceExpiresInSeconds,
      })
    }
    await this.updateState(agentContext, issuanceSession, OpenId4VcIssuanceSessionState.CredentialRequestReceived)

    let previousNonce: string | undefined = undefined
    const proofSigners: JwtSigner[] = []
    for (const jwt of proofs.jwt) {
      const { signer, payload } = await vcIssuer.verifyCredentialRequestJwtProof({
        issuerMetadata,
        jwt,
        clientId: options.issuanceSession.clientId,
      })

      if (!payload.nonce) {
        const { cNonce, cNonceExpiresInSeconds } = await this.createNonce(agentContext, issuer)
        throw new Oauth2ServerErrorResponseError({
          error: Oauth2ErrorCodes.InvalidProof,
          error_description: 'Missing nonce in proof(s) in credential request',
          c_nonce: cNonce,
          c_nonce_expires_in: cNonceExpiresInSeconds,
        })
      }

      // Set previous nonce if not yet set (first iteration)
      if (!previousNonce) previousNonce = payload.nonce
      if (previousNonce !== payload.nonce) {
        const { cNonce, cNonceExpiresInSeconds } = await this.createNonce(agentContext, issuer)
        throw new Oauth2ServerErrorResponseError({
          error: Oauth2ErrorCodes.InvalidProof,
          error_description: 'Not all nonce values in proofs are equal',
          c_nonce: cNonce,
          c_nonce_expires_in: cNonceExpiresInSeconds,
        })
      }

      // Verify the nonce
      await this.verifyNonce(agentContext, issuer, payload.nonce).catch(async (error) => {
        const { cNonce, cNonceExpiresInSeconds } = await this.createNonce(agentContext, issuer)
        throw new Oauth2ServerErrorResponseError(
          {
            error: Oauth2ErrorCodes.InvalidNonce,
            error_description: 'Invalid nonce in credential request',
            c_nonce: cNonce,
            c_nonce_expires_in: cNonceExpiresInSeconds,
          },
          {
            cause: error,
          }
        )
      })

      proofSigners.push(signer)
    }

    const signedCredentials = await this.getSignedCredentials(agentContext, {
      credentialRequest,
      issuanceSession,
      issuer,
      requestFormat: format,
      credentialRequestToCredentialMapper: options.credentialRequestToCredentialMapper,
      proofSigners,
    })

    // NOTE: nonce in crednetial response is deprecated in newer drafts, but for now we keep it in
    const { cNonce, cNonceExpiresInSeconds } = await this.createNonce(agentContext, issuer)
    const credentialResponse = vcIssuer.createCredentialResponse({
      credential: credentialRequest.proof ? signedCredentials.credentials[0] : undefined,
      credentials: credentialRequest.proofs ? signedCredentials.credentials : undefined,
      cNonce,
      cNonceExpiresInSeconds,
      credentialRequest: parsedCredentialRequest,
    })

    issuanceSession.issuedCredentials.push(signedCredentials.credentialConfigurationId)
    const newState =
      issuanceSession.issuedCredentials.length >=
      issuanceSession.credentialOfferPayload.credential_configuration_ids.length
        ? OpenId4VcIssuanceSessionState.Completed
        : OpenId4VcIssuanceSessionState.CredentialsPartiallyIssued
    await this.updateState(agentContext, issuanceSession, newState)

    return {
      credentialResponse,
      issuanceSession,
    }
  }

  public async findIssuanceSessionsByQuery(
    agentContext: AgentContext,
    query: Query<OpenId4VcIssuanceSessionRecord>,
    queryOptions?: QueryOptions
  ) {
    return this.openId4VcIssuanceSessionRepository.findByQuery(agentContext, query, queryOptions)
  }

  public async getIssuanceSessionById(agentContext: AgentContext, issuanceSessionId: string) {
    return this.openId4VcIssuanceSessionRepository.getById(agentContext, issuanceSessionId)
  }

  public async getAllIssuers(agentContext: AgentContext) {
    return this.openId4VcIssuerRepository.getAll(agentContext)
  }

  public async getIssuerByIssuerId(agentContext: AgentContext, issuerId: string) {
    return this.openId4VcIssuerRepository.getByIssuerId(agentContext, issuerId)
  }

  public async updateIssuer(agentContext: AgentContext, issuer: OpenId4VcIssuerRecord) {
    return this.openId4VcIssuerRepository.update(agentContext, issuer)
  }

  public async createIssuer(agentContext: AgentContext, options: OpenId4VciCreateIssuerOptions) {
    // TODO: ideally we can store additional data with a key, such as:
    // - createdAt
    // - purpose
    const accessTokenSignerKey = await agentContext.wallet.createKey({
      keyType: options.accessTokenSignerKeyType ?? KeyType.Ed25519,
    })

    // this is required for HAIP
    // TODO: do we also need to provide some way to let the wallet know which authorization server
    // TODO: can issue which credentials?
    const openId4VcIssuer = new OpenId4VcIssuerRecord({
      issuerId: options.issuerId ?? utils.uuid(),
      display: options.display,
      dpopSigningAlgValuesSupported: options.dpopSigningAlgValuesSupported,
      accessTokenPublicKeyFingerprint: accessTokenSignerKey.fingerprint,
      authorizationServerConfigs: options.authorizationServerConfigs,
      credentialConfigurationsSupported: options.credentialConfigurationsSupported,
    })

    await this.openId4VcIssuerRepository.save(agentContext, openId4VcIssuer)
    await storeActorIdForContextCorrelationId(agentContext, openId4VcIssuer.issuerId)
    return openId4VcIssuer
  }

  public async rotateAccessTokenSigningKey(
    agentContext: AgentContext,
    issuer: OpenId4VcIssuerRecord,
    options?: Pick<OpenId4VciCreateIssuerOptions, 'accessTokenSignerKeyType'>
  ) {
    const accessTokenSignerKey = await agentContext.wallet.createKey({
      keyType: options?.accessTokenSignerKeyType ?? KeyType.Ed25519,
    })

    // TODO: ideally we can remove the previous key
    issuer.accessTokenPublicKeyFingerprint = accessTokenSignerKey.fingerprint
    await this.openId4VcIssuerRepository.update(agentContext, issuer)
  }

  /**
   * @param fetchExternalAuthorizationServerMetadata defaults to false
   */
  public async getIssuerMetadata(
    agentContext: AgentContext,
    issuerRecord: OpenId4VcIssuerRecord,
    fetchExternalAuthorizationServerMetadata = false
  ): Promise<OpenId4VciMetadata> {
    const config = agentContext.dependencyManager.resolve(OpenId4VcIssuerModuleConfig)
    const issuerUrl = joinUriParts(config.baseUrl, [issuerRecord.issuerId])
    const oauth2Client = this.getOauth2Client(agentContext)

    const extraAuthorizationServers: AuthorizationServerMetadata[] =
      fetchExternalAuthorizationServerMetadata && issuerRecord.authorizationServerConfigs
        ? await Promise.all(
            issuerRecord.authorizationServerConfigs.map(async (server) => {
              const metadata = await oauth2Client.fetchAuthorizationServerMetadata(server.issuer)
              if (!metadata)
                throw new CredoError(`Authorization server metadata not found for issuer '${server.issuer}'`)
              return metadata
            })
          )
        : []

    const authorizationServers =
      issuerRecord.authorizationServerConfigs && issuerRecord.authorizationServerConfigs.length > 0
        ? [
            ...issuerRecord.authorizationServerConfigs.map((authorizationServer) => authorizationServer.issuer),
            // Our issuer is also a valid authorization server (only for pre-auth)
            issuerUrl,
          ]
        : undefined

    const credentialIssuerMetadata = {
      credential_issuer: issuerUrl,
      credential_endpoint: joinUriParts(issuerUrl, [config.credentialEndpoint.endpointPath]),
      credential_configurations_supported: issuerRecord.credentialConfigurationsSupported ?? {},
      authorization_servers: authorizationServers,
      display: issuerRecord.display,
      nonce_endpoint: joinUriParts(issuerUrl, [config.nonceEndpoint.endpointPath]),
    } satisfies CredentialIssuerMetadata

    const issuerAuthorizationServer = {
      issuer: issuerUrl,
      token_endpoint: joinUriParts(issuerUrl, [config.accessTokenEndpoint.endpointPath]),
      'pre-authorized_grant_anonymous_access_supported': true,

      jwks_uri: joinUriParts(issuerUrl, ['jwks.json']),

      // TODO: presentation during issuance
      // authorization_challenge_endpoint: ''

      // TODO: PAR (maybe not needed as we only use this auth server for presentation during issuance)
      // pushed_authorization_request_endpoint: '',
      // require_pushed_authorization_requests: true

      code_challenge_methods_supported: [PkceCodeChallengeMethod.S256],
      dpop_signing_alg_values_supported: issuerRecord.dpopSigningAlgValuesSupported,
    } satisfies AuthorizationServerMetadata

    return {
      credentialIssuer: credentialIssuerMetadata,
      authorizationServers: [issuerAuthorizationServer, ...extraAuthorizationServers],
    }
  }

  public async createNonce(agentContext: AgentContext, issuer: OpenId4VcIssuerRecord) {
    const issuerMetadata = await this.getIssuerMetadata(agentContext, issuer)
    const jwsService = agentContext.dependencyManager.resolve(JwsService)

    const cNonceExpiresInSeconds = this.openId4VcIssuerConfig.nonceEndpoint.cNonceExpiresInSeconds
    const cNonceExpiresAt = addSecondsToDate(new Date(), cNonceExpiresInSeconds)

    const key = Key.fromFingerprint(issuer.accessTokenPublicKeyFingerprint)
    const jwk = getJwkFromKey(key)

    const cNonce = await jwsService.createJwsCompact(agentContext, {
      key,
      payload: JwtPayload.fromJson({
        iss: issuerMetadata.credentialIssuer.credential_issuer,
        exp: dateToSeconds(cNonceExpiresAt),
      }),
      protectedHeaderOptions: {
        typ: 'credo+cnonce',
        kid: issuer.accessTokenPublicKeyFingerprint,
        alg: jwk.supportedSignatureAlgorithms[0],
      },
    })

    return {
      cNonce,
      cNonceExpiresAt,
      cNonceExpiresInSeconds,
    }
  }

  /**
   * @todo nonces are very short lived (1 min), but it might be nice to also cache the nonces
   * in the cache if we have 'seen' them. They will only be in the cache for a short time
   * and it will prevent replay
   */
  private async verifyNonce(agentContext: AgentContext, issuer: OpenId4VcIssuerRecord, cNonce: string) {
    const issuerMetadata = await this.getIssuerMetadata(agentContext, issuer)
    const jwsService = agentContext.dependencyManager.resolve(JwsService)

    const key = Key.fromFingerprint(issuer.accessTokenPublicKeyFingerprint)
    const jwk = getJwkFromKey(key)

    const jwt = Jwt.fromSerializedJwt(cNonce)
    jwt.payload.validate()

    if (jwt.payload.iss !== issuerMetadata.credentialIssuer.credential_issuer) {
      throw new CredoError(`Invalid 'iss' claim in cNonce jwt`)
    }
    if (jwt.header.typ !== 'credo+cnonce') {
      throw new CredoError(`Invalid 'typ' claim in cNonce jwt header`)
    }

    const verification = await jwsService.verifyJws(agentContext, {
      jws: cNonce,
      jwkResolver: () => jwk,
    })

    if (
      !verification.signerKeys
        .map((singerKey) => singerKey.fingerprint)
        .includes(issuer.accessTokenPublicKeyFingerprint)
    ) {
      throw new CredoError('Invalid nonce')
    }
  }

  public getIssuer(agentContext: AgentContext) {
    return new Oid4vciIssuer({
      callbacks: getOid4vciCallbacks(agentContext),
    })
  }

  public getOauth2Client(agentContext: AgentContext) {
    return new Oauth2Client({
      callbacks: getOid4vciCallbacks(agentContext),
    })
  }

  public getOauth2AuthorizationServer(agentContext: AgentContext) {
    return new Oauth2AuthorizationServer({
      callbacks: getOid4vciCallbacks(agentContext),
    })
  }

  public getResourceServer(agentContext: AgentContext, issuerRecord: OpenId4VcIssuerRecord) {
    return new Oauth2ResourceServer({
      callbacks: {
        ...getOid4vciCallbacks(agentContext),
        clientAuthentication: dynamicOid4vciClientAuthentication(agentContext, issuerRecord),
      },
    })
  }

  /**
   * Update the record to a new state and emit an state changed event. Also updates the record
   * in storage.
   */
  public async updateState(
    agentContext: AgentContext,
    issuanceSession: OpenId4VcIssuanceSessionRecord,
    newState: OpenId4VcIssuanceSessionState
  ) {
    agentContext.config.logger.debug(
      `Updating openid4vc issuance session record ${issuanceSession.id} to state ${newState} (previous=${issuanceSession.state})`
    )

    const previousState = issuanceSession.state
    issuanceSession.state = newState
    await this.openId4VcIssuanceSessionRepository.update(agentContext, issuanceSession)

    this.emitStateChangedEvent(agentContext, issuanceSession, previousState)
  }

  private emitStateChangedEvent(
    agentContext: AgentContext,
    issuanceSession: OpenId4VcIssuanceSessionRecord,
    previousState: OpenId4VcIssuanceSessionState | null
  ) {
    const eventEmitter = agentContext.dependencyManager.resolve(EventEmitter)

    eventEmitter.emit<OpenId4VcIssuanceSessionStateChangedEvent>(agentContext, {
      type: OpenId4VcIssuerEvents.IssuanceSessionStateChanged,
      payload: {
        issuanceSession: issuanceSession.clone(),
        previousState: previousState,
      },
    })
  }

  private async getGrantsFromConfig(
    agentContext: AgentContext,
    config: {
      preAuthorizedCodeFlowConfig?: OpenId4VciPreAuthorizedCodeFlowConfig
      authorizationCodeFlowConfig?: OpenId4VciAuthorizationCodeFlowConfig
    }
  ) {
    const { preAuthorizedCodeFlowConfig, authorizationCodeFlowConfig } = config

    // TODO: export form @animo-id/oid4vci
    const grants: Parameters<Oid4vciIssuer['createCredentialOffer']>[0]['grants'] = {}

    // Pre auth
    if (preAuthorizedCodeFlowConfig) {
      const { txCode, authorizationServerUrl, preAuthorizedCode } = preAuthorizedCodeFlowConfig

      grants[preAuthorizedCodeGrantIdentifier] = {
        'pre-authorized_code': preAuthorizedCode ?? (await agentContext.wallet.generateNonce()),
        tx_code: txCode,
        authorization_server: authorizationServerUrl,
      }
    }

    // Auth
    if (authorizationCodeFlowConfig) {
      grants.authorization_code = {
        issuer_state: authorizationCodeFlowConfig.issuerState ?? (await agentContext.wallet.generateNonce()),
        authorization_server: authorizationCodeFlowConfig.authorizationServerUrl,
      }
    }

    return grants
  }

  private async getHolderBindingFromRequestProofs(agentContext: AgentContext, proofSigners: JwtSigner[]) {
    const credentialHolderBindings: OpenId4VcCredentialHolderBindingWithKey[] = []
    for (const signer of proofSigners) {
      if (signer.method === 'custom' || signer.method === 'x5c') {
        throw new CredoError(`Only 'jwk' and 'did' based holder binding is supported`)
      }

      if (signer.method === 'jwk') {
        const jwk = getJwkFromJson(signer.publicJwk)
        credentialHolderBindings.push({
          method: 'jwk',
          jwk,
          key: jwk.key,
        })
      }

      if (signer.method === 'did') {
        const key = await getKeyFromDid(agentContext, signer.didUrl)
        credentialHolderBindings.push({
          method: 'did',
          didUrl: signer.didUrl,
          key,
        })
      }
    }

    return credentialHolderBindings
  }

  private async getSignedCredentials(
    agentContext: AgentContext,
    options: OpenId4VciCreateCredentialResponseOptions & {
      issuer: OpenId4VcIssuerRecord
      issuanceSession: OpenId4VcIssuanceSessionRecord
      requestFormat: CredentialRequestFormatSpecific
      proofSigners: JwtSigner[]
    }
  ): Promise<{
    credentials: string[] | Record<string, unknown>[]
    format: `${OpenId4VciCredentialFormatProfile}`
    credentialConfigurationId: string
  }> {
    const { issuanceSession, issuer, requestFormat } = options
    const issuerMetadata = await this.getIssuerMetadata(agentContext, issuer)

    const notIssuedCredentialConfigurationIds =
      options.issuanceSession.credentialOfferPayload.credential_configuration_ids.filter(
        (id) => !issuanceSession.issuedCredentials.includes(id)
      )

    // TODO: this + next validation should be handeld by oid4vci lib
    const offeredCredentialsMatchingRequest = getCredentialConfigurationsMatchingRequestFormat({
      requestFormat,
      credentialConfigurations: getOfferedCredentials(
        notIssuedCredentialConfigurationIds,
        issuerMetadata.credentialIssuer.credential_configurations_supported
      ),
    })

    const matchingCredentialConfigurationIds = Object.keys(offeredCredentialsMatchingRequest) as [string, ...string[]]
    if (matchingCredentialConfigurationIds.length === 0) {
      throw new Oauth2ServerErrorResponseError({
        error: Oauth2ErrorCodes.CredentialRequestDenied,
        error_description: 'No offered credentials matching the credential request',
      })
    }

    const mapper =
      options.credentialRequestToCredentialMapper ??
      this.openId4VcIssuerConfig.credentialEndpoint.credentialRequestToCredentialMapper

    const holderBindings = await this.getHolderBindingFromRequestProofs(agentContext, options.proofSigners)
    const signOptions = await mapper({
      agentContext,
      issuanceSession,
      holderBindings,
      credentialOffer: issuanceSession.credentialOfferPayload,

      credentialRequest: options.credentialRequest,
      credentialRequestFormat: options.requestFormat,

      // Macthing credential configuration ids
      credentialConfigurationsSupported: offeredCredentialsMatchingRequest,
      credentialConfigurationIds: matchingCredentialConfigurationIds,
    })

    const credentialHasAlreadyBeenIssued = issuanceSession.issuedCredentials.includes(
      signOptions.credentialConfigurationId
    )

    if (credentialHasAlreadyBeenIssued) {
      throw new CredoError(
        `Credential request to credential mapper returned '${signOptions.credentials.length}' to be signed, while only '${holderBindings.length}' holder binding entries were provided. Make sure to return one credential for each holder binding entry`
      )
    }

    // NOTE: we may want to allow a mismatch between this (as with new attestations not every key
    // needs a separate proof), but for it needs to match
    if (signOptions.credentials.length !== holderBindings.length) {
      throw new CredoError(
        `Credential request to credential mapper returned '${signOptions.credentials.length}' to be signed, while only '${holderBindings.length}' holder binding entries were provided. Make sure to return one credential for each holder binding entry`
      )
    }

    if (signOptions.format === ClaimFormat.JwtVc || signOptions.format === ClaimFormat.LdpVc) {
      const oid4vciFormatMap: Record<string, ClaimFormat.JwtVc | ClaimFormat.LdpVc> = {
        [OpenId4VciCredentialFormatProfile.JwtVcJson]: ClaimFormat.JwtVc,
        [OpenId4VciCredentialFormatProfile.JwtVcJsonLd]: ClaimFormat.JwtVc,
        [OpenId4VciCredentialFormatProfile.LdpVc]: ClaimFormat.LdpVc,
      }

      const expectedClaimFormat = oid4vciFormatMap[options.requestFormat.format]
      if (signOptions.format !== expectedClaimFormat) {
        throw new CredoError(
          `Invalid credential format returned by sign options. Expected '${expectedClaimFormat}', received '${signOptions.format}'.`
        )
      }

      return {
        credentialConfigurationId: signOptions.credentialConfigurationId,
        format: requestFormat.format,
        credentials: (await Promise.all(
          signOptions.credentials.map((credential) =>
            this.signW3cCredential(agentContext, signOptions.format, credential).then((signed) => signed.encoded)
          )
        )) as string[] | Record<string, unknown>[],
      }
    } else if (signOptions.format === ClaimFormat.SdJwtVc) {
      if (signOptions.format !== requestFormat.format) {
        throw new CredoError(
          `Invalid credential format returned by sign options. Expected '${requestFormat.format}', received '${signOptions.format}'.`
        )
      }

      if (!signOptions.credentials.every((c) => c.payload.vct === requestFormat.vct)) {
        throw new CredoError(
          `One or more vct values of the offered credential(s) do not match the vct of the requested credential. Offered ${Array.from(
            new Set(signOptions.credentials.map((c) => `'${c.payload.vct}'`))
          ).join(', ')} Requested '${requestFormat.vct}'.`
        )
      }

      const sdJwtVcApi = agentContext.dependencyManager.resolve(SdJwtVcApi)
      return {
        credentialConfigurationId: signOptions.credentialConfigurationId,
        format: OpenId4VciCredentialFormatProfile.SdJwtVc,
        credentials: await Promise.all(
          signOptions.credentials.map((credential) => sdJwtVcApi.sign(credential).then((signed) => signed.compact))
        ),
      }
    } else if (signOptions.format === ClaimFormat.MsoMdoc) {
      if (signOptions.format !== requestFormat.format) {
        throw new CredoError(
          `Invalid credential format returned by sign options. Expected '${requestFormat.format}', received '${signOptions.format}'.`
        )
      }
      if (!signOptions.credentials.every((c) => c.docType === requestFormat.doctype)) {
        throw new CredoError(
          `One or more doctype values of the offered credential(s) do not match the doctype of the requested credential. Offered ${Array.from(
            new Set(signOptions.credentials.map((c) => `'${c.docType}'`))
          ).join(', ')} Requested '${requestFormat.doctype}'.`
        )
      }

      const mdocApi = agentContext.dependencyManager.resolve(MdocApi)
      return {
        credentialConfigurationId: signOptions.credentialConfigurationId,
        format: OpenId4VciCredentialFormatProfile.MsoMdoc,
        credentials: await Promise.all(
          signOptions.credentials.map((credential) => mdocApi.sign(credential).then((signed) => signed.base64Url))
        ),
      }
    } else {
      throw new CredoError(`Unsupported credential format ${signOptions.format}`)
    }
  }

  private async signW3cCredential(
    agentContext: AgentContext,
    format: `${ClaimFormat.JwtVc}` | `${ClaimFormat.LdpVc}`,
    options: OpenId4VciSignW3cCredentials['credentials'][number]
  ) {
    const key = await getKeyFromDid(agentContext, options.verificationMethod)
    if (format === ClaimFormat.JwtVc) {
      const supportedSignatureAlgorithms = getJwkFromKey(key).supportedSignatureAlgorithms
      if (supportedSignatureAlgorithms.length === 0) {
        throw new CredoError(`No supported JWA signature algorithms found for key with keyType ${key.keyType}`)
      }

      const alg = supportedSignatureAlgorithms[0]
      if (!alg) {
        throw new CredoError(`No supported JWA signature algorithms for key type ${key.keyType}`)
      }

      return await this.w3cCredentialService.signCredential(agentContext, {
        format: ClaimFormat.JwtVc,
        credential: options.credential,
        verificationMethod: options.verificationMethod,
        alg,
      })
    } else {
      const proofType = getProofTypeFromKey(agentContext, key)

      return await this.w3cCredentialService.signCredential(agentContext, {
        format: ClaimFormat.LdpVc,
        credential: options.credential,
        verificationMethod: options.verificationMethod,
        proofType: proofType,
      })
    }
  }
}
