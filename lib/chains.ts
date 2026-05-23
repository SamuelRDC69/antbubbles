import { ChainConfig } from './types'

export const CHAINS: Record<string, ChainConfig> = {
  wax: {
    id: 'wax',
    name: 'wax',
    displayName: 'WAX',
    apiBase: 'https://wax.alcor.exchange/api/v2',
    systemToken: 'WAX',
    systemContract: 'eosio.token',
    explorerBase: 'https://waxblock.io',
    color: '#f89422',
    nodeUrl: 'https://wax.greymass.com',
  },
  eos: {
    id: 'eos',
    name: 'eos',
    displayName: 'EOS',
    apiBase: 'https://eos.alcor.exchange/api/v2',
    systemToken: 'EOS',
    systemContract: 'eosio.token',
    explorerBase: 'https://eosauthority.com',
    color: '#3d3d3d',
    nodeUrl: 'https://eos.greymass.com',
  },
  telos: {
    id: 'telos',
    name: 'telos',
    displayName: 'Telos',
    apiBase: 'https://telos.alcor.exchange/api/v2',
    systemToken: 'TLOS',
    systemContract: 'eosio.token',
    explorerBase: 'https://explorer.telos.net',
    color: '#571aff',
    nodeUrl: 'https://telos.greymass.com',
  },
  proton: {
    id: 'proton',
    name: 'proton',
    displayName: 'Proton',
    apiBase: 'https://proton.alcor.exchange/api/v2',
    systemToken: 'XPR',
    systemContract: 'eosio.token',
    explorerBase: 'https://explorer.xprnetwork.org',
    color: '#7b3fe4',
    nodeUrl: 'https://proton.greymass.com',
  },
}

export const DEFAULT_CHAIN = 'wax'
