// Loaded only from a fresh smoke-test profile, before tabby-rdp. No native credential-store methods are called.
const Module = require('node:module')
const values = new Map()
const id = (service, account) => JSON.stringify([service, account])
const fake = {
    getPassword: async (service, account) => values.get(id(service, account)) ?? null,
    setPassword: async (service, account, password) => { values.set(id(service, account), password) },
    deletePassword: async (service, account) => values.delete(id(service, account)),
    findCredentials: async service => [...values].flatMap(([key, password]) => {
        const [storedService, account] = JSON.parse(key)
        return storedService === service ? [{ account, password }] : []
    }),
    findPassword: async service => (await fake.findCredentials(service))[0]?.password ?? null,
}
// A built-in provider may have imported the module already: replace that object's methods as well.
try { Object.assign(require('keytar'), fake) } catch { }
const load = Module._load
Module._load = function (name, ...args) {
    return name === 'keytar' ? fake : load.call(this, name, ...args)
}
globalThis.__trdSmokeCredentials = true
class SmokeCredentials { }
require('@angular/core').NgModule({})(SmokeCredentials)
module.exports = { default: SmokeCredentials }
