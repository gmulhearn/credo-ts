/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { SubjectMessage } from '../../../../../../tests/transport/SubjectInboundTransport'
import type { ConnectionRecord } from '../../../modules/connections'

import { Subject } from 'rxjs'

import { SubjectInboundTransport } from '../../../../../../tests/transport/SubjectInboundTransport'
import { SubjectOutboundTransport } from '../../../../../../tests/transport/SubjectOutboundTransport'
import { getIndySdkModules } from '../../../../../indy-sdk/tests/setupIndySdkModule'
import { getAgentOptions, makeConnection, waitForBasicMessage } from '../../../../tests/helpers'
import testLogger from '../../../../tests/logger'
import { Agent } from '../../../agent/Agent'
import { MessageSendingError, RecordNotFoundError } from '../../../error'
import { BasicMessage } from '../messages'
import { BasicMessageRecord } from '../repository'

const faberConfig = getAgentOptions(
  'Faber Basic Messages',
  {
    endpoints: ['rxjs:faber'],
  },
  getIndySdkModules()
)

const aliceConfig = getAgentOptions(
  'Alice Basic Messages',
  {
    endpoints: ['rxjs:alice'],
  },
  getIndySdkModules()
)

describe('Basic Messages E2E', () => {
  let faberAgent: Agent
  let aliceAgent: Agent
  let faberConnection: ConnectionRecord
  let aliceConnection: ConnectionRecord

  beforeEach(async () => {
    const faberMessages = new Subject<SubjectMessage>()
    const aliceMessages = new Subject<SubjectMessage>()
    const subjectMap = {
      'rxjs:faber': faberMessages,
      'rxjs:alice': aliceMessages,
    }

    faberAgent = new Agent(faberConfig)
    faberAgent.registerInboundTransport(new SubjectInboundTransport(faberMessages))
    faberAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await faberAgent.initialize()

    aliceAgent = new Agent(aliceConfig)
    aliceAgent.registerInboundTransport(new SubjectInboundTransport(aliceMessages))
    aliceAgent.registerOutboundTransport(new SubjectOutboundTransport(subjectMap))
    await aliceAgent.initialize()
    ;[aliceConnection, faberConnection] = await makeConnection(aliceAgent, faberAgent)
  })

  afterEach(async () => {
    await faberAgent.shutdown()
    await faberAgent.wallet.delete()
    await aliceAgent.shutdown()
    await aliceAgent.wallet.delete()
  })

  test('Alice and Faber exchange messages', async () => {
    testLogger.test('Alice sends message to Faber')
    const helloRecord = await aliceAgent.basicMessages.sendMessage(aliceConnection.id, 'Hello')

    expect(helloRecord.content).toBe('Hello')

    testLogger.test('Faber waits for message from Alice')
    await waitForBasicMessage(faberAgent, {
      content: 'Hello',
    })

    testLogger.test('Faber sends message to Alice')
    const replyRecord = await faberAgent.basicMessages.sendMessage(faberConnection.id, 'How are you?')
    expect(replyRecord.content).toBe('How are you?')

    testLogger.test('Alice waits until she receives message from faber')
    await waitForBasicMessage(aliceAgent, {
      content: 'How are you?',
    })
  })

  test('Alice and Faber exchange messages using threadId', async () => {
    testLogger.test('Alice sends message to Faber')
    const helloRecord = await aliceAgent.basicMessages.sendMessage(aliceConnection.id, 'Hello')

    expect(helloRecord.content).toBe('Hello')

    testLogger.test('Faber waits for message from Alice')
    const helloMessage = await waitForBasicMessage(faberAgent, {
      content: 'Hello',
    })

    testLogger.test('Faber sends message to Alice')
    const replyRecord = await faberAgent.basicMessages.sendMessage(faberConnection.id, 'How are you?', helloMessage.id)
    expect(replyRecord.content).toBe('How are you?')
    expect(replyRecord.parentThreadId).toBe(helloMessage.id)

    testLogger.test('Alice waits until she receives message from faber')
    const replyMessage = await waitForBasicMessage(aliceAgent, {
      content: 'How are you?',
    })
    expect(replyMessage.content).toBe('How are you?')
    expect(replyMessage.thread?.parentThreadId).toBe(helloMessage.id)

    // Both sender and recipient shall be able to find the threaded messages
    // Hello message
    const aliceHelloMessage = await aliceAgent.basicMessages.getByThreadId(helloMessage.id)
    const faberHelloMessage = await faberAgent.basicMessages.getByThreadId(helloMessage.id)
    expect(aliceHelloMessage).toMatchObject({
      content: helloRecord.content,
      threadId: helloRecord.threadId,
    })
    expect(faberHelloMessage).toMatchObject({
      content: helloRecord.content,
      threadId: helloRecord.threadId,
    })

    // Reply message
    const aliceReplyMessages = await aliceAgent.basicMessages.findAllByQuery({ parentThreadId: helloMessage.id })
    const faberReplyMessages = await faberAgent.basicMessages.findAllByQuery({ parentThreadId: helloMessage.id })
    expect(aliceReplyMessages.length).toBe(1)
    expect(aliceReplyMessages[0]).toMatchObject({
      content: replyRecord.content,
      parentThreadId: replyRecord.parentThreadId,
      threadId: replyRecord.threadId,
    })
    expect(faberReplyMessages.length).toBe(1)
    expect(faberReplyMessages[0]).toMatchObject(replyRecord)
  })

  test('Alice is unable to send a message', async () => {
    testLogger.test('Alice sends message to Faber that is undeliverable')

    const spy = jest.spyOn(aliceAgent.outboundTransports[0], 'sendMessage').mockRejectedValue(new Error('any error'))

    await expect(aliceAgent.basicMessages.sendMessage(aliceConnection.id, 'Hello')).rejects.toThrowError(
      MessageSendingError
    )
    try {
      await aliceAgent.basicMessages.sendMessage(aliceConnection.id, 'Hello undeliverable')
    } catch (error) {
      const thrownError = error as MessageSendingError
      expect(thrownError.message).toEqual(
        `Message is undeliverable to connection ${aliceConnection.id} (${aliceConnection.theirLabel})`
      )

      testLogger.test('Error thrown includes the outbound message and recently created record id')
      expect(thrownError.outboundMessageContext.associatedRecord).toBeInstanceOf(BasicMessageRecord)
      expect(thrownError.outboundMessageContext.message).toBeInstanceOf(BasicMessage)
      expect((thrownError.outboundMessageContext.message as BasicMessage).content).toBe('Hello undeliverable')

      testLogger.test('Created record can be found and deleted by id')
      const storedRecord = await aliceAgent.basicMessages.getById(
        thrownError.outboundMessageContext.associatedRecord!.id
      )
      expect(storedRecord).toBeInstanceOf(BasicMessageRecord)
      expect(storedRecord.content).toBe('Hello undeliverable')

      await aliceAgent.basicMessages.deleteById(storedRecord.id)
      await expect(
        aliceAgent.basicMessages.getById(thrownError.outboundMessageContext.associatedRecord!.id)
      ).rejects.toThrowError(RecordNotFoundError)
    }
    spy.mockClear()
  })
})
