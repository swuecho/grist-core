import * as t from "ts-interface-checker";
// tslint:disable:object-literal-key-quotes

export const InternalImportSourceAPI = t.iface([], {
  "getImportSource": t.func(t.union("ImportSource", "undefined"), t.param("inlineTarget", "RenderTarget")),
});

const exportedTypeSuite: t.ITypeSuite = {
  InternalImportSourceAPI,
};
export default exportedTypeSuite;
