/**
 * Everything a Wealthfolio connector needs that is not about one broker.
 *
 * The rule for what belongs here: if a second connector — a different broker,
 * or a bank — would need the same code, it lives in the kit. Anything that
 * knows what a Trading 212 order looks like does not.
 */
export { createBrokeredFetch } from './brokered-fetch';
export type { BrokeredAuth } from './brokered-fetch';
export { toBasicSecret, saveCredentials, hasCredentials, clearCredentials } from './credentials';
export { saveKeyPair, readKeyPair, hasKeyPair, clearKeyPair } from './credentials';
export type { KeyPairKeys } from './credentials';
export { findLinkedAccount, linkOrCreateAccount, describeMismatch } from './account';
export type { BrokerAccount, LinkOptions, LinkResult } from './account';
export { reconcileAssetCurrencies } from './asset-currency';
export type { CurrencyFix, CurrencySource } from './asset-currency';
