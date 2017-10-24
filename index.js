process.on('unhandledRejection', error => {
  console.log('unhandledRejection', error.message)
})

const fs = require('fs')
const pify = require('pify')
const onStreamEnd = require('end-of-stream')
const EthRpcClient = require('eth-rpc-client')
const EthQuery = require('ethjs-query')
const binToOps = require('eth-bin-to-ops')
const createVmTraceStream = require('eth-tx-summary').createVmTraceStream
const createCallTraceTransform = require('eth-tx-summary/call-trace')
const createZeroClient = require('web3-provider-engine/zero')


const newOpcodeNames = {
  'fa': 'STATICCALL',
  '3d': 'RETURNDATASIZE',
  '3e': 'RETURNDATACOPY',
  'fd': 'REVERT',
}
const newOpcodeBytes = Object.keys(newOpcodeNames)

searchBlockchain({
  network: 'mainnet',
  fromBlock: 4370000,
})

searchBlockchain({
  network: 'ropsten',
  fromBlock: 1700000,
})

searchBlockchain({
  network: 'rinkeby',
  fromBlock: 1035301,
})


function searchBlockchain({ fromBlock, network }) {
  fs.appendFileSync(`./${network}-txs.txt`, `\nstart from #${fromBlock} ${new Date().toDateString()}\n`)

  const { blockTracker } = new EthRpcClient({
    getAccounts: (cb) => { cb(null, []) },
  })
  // override the provider bc EthRpcClient is broken
  const provider = createZeroClient({
    rpcUrl: `https://${network}.infura.io`,
    getAccounts: (cb) => cb(null, []),
  })

  const eth = new EthQuery(provider)

  blockTracker.once('block', () => {
    blockTracker.stop()
    blockTracker.start({ fromBlock: `0x${fromBlock.toString(16)}`, })
    blockTracker.on('block', async (block, cb) => {
      console.log(`${network} #${parseInt(block.number, 16)}`)
      cb()
      try {
        const matchingTxs = await inspectBlockForEccTxs(block)
        if (matchingTxs.length) {
          console.log('found some txs!', matchingTxs)
          fs.appendFileSync(`./${network}-txs.txt`, JSON.stringify(matchingTxs)+'\n')
        }
      } catch (err) {
        console.error(err)
      }
      // cb()
    })
  })

  async function inspectBlockForNewOpcodeDeploys(block) {
    const contractDeploys = block.transactions.filter(tx => !tx.to)
    // console.log(`#${block.number}: ${contractDeploys.length} contracts deployed`)
    const contractAddresses = await Promise.all(contractDeploys.map(addressFromDeploy))
    for (address of contractAddresses) {
      const usedOpcodes = await getOpcodeUsage(address, newOpcodeBytes)
      if (!usedOpcodes.length) continue
      const opcodeLabels = usedOpcodes.map(byte => newOpcodeNames[byte]).join(', ')
      console.log(`${address}: ${opcodeLabels}`)
    }
  }

  async function inspectBlockForEccTxs(block) {
    const nonContractDeploys = block.transactions.filter(tx => tx.to)
    const matchingTxs = []

    for (let tx of nonContractDeploys) {
      const hasPush8 = await hasMatchingPush(tx.to, Buffer.from('08', 'hex'))
      if (!hasPush8) continue

      const vmStream = createVmTraceStream(provider, tx.hash)
      const callTraceTransform = createCallTraceTransform()
      vmStream.on('error', console.error)
      vmStream.pipe(callTraceTransform)

      let didFindSendToPrecompile8 = false

      callTraceTransform.on('data', (event) => {
        if (event.type !== 'message') return
        const message = event.data
        if ([
          '0x0000000000000000000000000000000000000006',
          '0x0000000000000000000000000000000000000007',
          '0x0000000000000000000000000000000000000008',
        ].includes(message.toAddress)) {
          didFindSendToPrecompile8 = true
        }
        // console.log(`${tx.hash}.${message.sequence}: ${message.fromAddress} -> ${message.toAddress}`)
      })
      await pify(onStreamEnd)(vmStream)

      if (didFindSendToPrecompile8) {
        matchingTxs.push(tx.hash)
      }
    }

    return matchingTxs
  }

  async function addressFromDeploy(tx) {
    const rx = await eth.getTransactionReceipt(tx.hash)
    // console.log(rx)
    return rx.contractAddress
  }

  async function getOpcodeUsage(address, opcodeBytes) {
    const codeString = await eth.getCode(address)
    const code = Buffer.from(codeString.slice(2), 'hex')
    const ops = binToOps(code)
    const matchingOpcodes = opcodeBytes.filter((newOpcode) => {
      return code.some((op) => {
        return newOpcode === op.toString(16)
      })
    })
    return matchingOpcodes
  }

  async function hasMatchingPush(address, data) {
    const codeString = await eth.getCode(address)
    const code = Buffer.from(codeString.slice(2), 'hex')
    const ops = binToOps(code)
    const hasMatchingOpcodes = ops.some((op) => {
      return op.pushData && data.equals(op.pushData)
    })
    return hasMatchingOpcodes
  }

}
