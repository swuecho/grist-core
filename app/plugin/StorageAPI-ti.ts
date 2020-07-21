import * as t from "ts-interface-checker";
// tslint:disable:object-literal-key-quotes

export const Storage = t.iface([], {
  "getItem": t.func("any", t.param("key", "string")),
  "hasItem": t.func("boolean", t.param("key", "string")),
  "setItem": t.func("void", t.param("key", "string"), t.param("value", "any")),
  "removeItem": t.func("void", t.param("key", "string")),
  "clear": t.func("void"),
});

const exportedTypeSuite: t.ITypeSuite = {
  Storage,
};
export default exportedTypeSuite;
