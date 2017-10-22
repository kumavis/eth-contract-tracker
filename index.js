const pify = require('pify')
const EthRpcClient = require('eth-rpc-client')
const EthQuery = require('ethjs-query')
const binToOps = require('eth-bin-to-ops')

const byzantiumForkNumber = 4370000
const newOpcodeNames = {
  'fa': 'STATICCALL',
  // '3d': 'RETURNDATASIZE',
  // '3e': 'RETURNDATACOPY',
  // 'fd': 'REVERT',
}
const newOpcodeBytes = Object.keys(newOpcodeNames)


const { provider, blockTracker } = new EthRpcClient({
  getAccounts: (cb) => { cb(null, []) },
})
const eth = new EthQuery(provider)

blockTracker.on('block', (block, cb) => {
  inspectBlock(block).then(cb).catch(cb)
})

blockTracker.stop()
blockTracker.start({ fromBlock: `0x${byzantiumForkNumber.toString(16)}` })

async function inspectBlock(block) {
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