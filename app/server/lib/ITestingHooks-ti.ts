/**
 * This module was automatically generated by `ts-interface-builder`
 */
import * as t from "ts-interface-checker";
// tslint:disable:object-literal-key-quotes

export const ITestingHooks = t.iface([], {
  "getOwnPort": t.func("number"),
  "getPort": t.func("number"),
  "updateAuthToken": t.func("void", t.param("instId", "string"), t.param("authToken", "string")),
  "getAuthToken": t.func(t.union("string", "null"), t.param("instId", "string")),
  "useTestToken": t.func("void", t.param("instId", "string"), t.param("token", "string")),
  "setLoginSessionProfile": t.func("void", t.param("gristSidCookie", "string"),
                                   t.param("profile", t.union("UserProfile", "null")), t.param("org", "string", true)),
  "setServerVersion": t.func("void", t.param("version", t.union("string", "null"))),
  "disconnectClients": t.func("void"),
  "commShutdown": t.func("void"),
  "commRestart": t.func("void"),
  "commSetClientPersistence": t.func("void", t.param("ttlMs", "number")),
  "closeDocs": t.func("void"),
  "setDocWorkerActivation": t.func("void", t.param("workerId", "string"),
                                   t.param("active", t.union(t.lit('active'),
                                                             t.lit('inactive'),
                                                             t.lit('crash')))),
  "flushAuthorizerCache": t.func("void"),
  "getDocClientCounts": t.func(t.array(t.tuple("string", "number"))),
  "setActiveDocTimeout": t.func("number", t.param("seconds", "number")),
});

const exportedTypeSuite: t.ITypeSuite = {
  ITestingHooks,
  UserProfile: t.name("object"),
};
export default exportedTypeSuite;
