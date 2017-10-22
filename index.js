process.on('unhandledRejection', error => {
  console.log('unhandledRejection', error.message)
})

const pify = require('pify')
const EthRpcClient = require('eth-rpc-client')
const EthQuery = require('ethjs-query')
const binToOps = require('eth-bin-to-ops')
const getCallTrace = require('eth-tx-summary/call-trace')
const createVmTraceStream = require('eth-tx-summary').createVmTraceStream

const byzantiumForkNumber = 4370000
const newOpcodeNames = {
  'fa': 'STATICCALL',
  '3d': 'RETURNDATASIZE',
  '3e': 'RETURNDATACOPY',
  'fd': 'REVERT',
}
const newOpcodeBytes = Object.keys(newOpcodeNames)



const { provider, blockTracker } = new EthRpcClient({
  getAccounts: (cb) => { cb(null, []) },
})
const eth = new EthQuery(provider)

blockTracker.on('block', (block, cb) => {
  inspectBlockForEccTxs(block).then(cb).catch((err) => {
    console.error(err)
    cb()
  })
})

blockTracker.stop()
blockTracker.start({ fromBlock: `0x${byzantiumForkNumber.toString(16)}` })

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
  for (let tx of nonContractDeploys) {
    const hasPush8 = await hasMatchingPush(tx.to, Buffer.from('08', 'hex'))
    if (!hasPush8) continue
    console.log(`${tx.hash}: has push 8`)
    console.log('begin trace')
    const callTrace = await pify(getCallTrace)(tx.hash, provider)
    console.log('end trace')
    console.log(callTrace)
    // const traceStream = createVmTraceStream(provider, tx.hash)
    // traceStream.on('data', (message) => {
    //   if (message.type !== 'step') return
    //   const toAddress = message.data.address.toString('hex')
    //   console.log(toAddress)
    // })
  }
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