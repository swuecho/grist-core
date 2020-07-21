/**
 * This module was automatically generated by `ts-interface-builder`
 */
import * as t from "ts-interface-checker";
// tslint:disable:object-literal-key-quotes

export const ComponentKind = t.union(t.lit("safeBrowser"), t.lit("safePython"), t.lit("unsafeNode"));

export const GristAPI = t.iface([], {
  "render": t.func("number", t.param("path", "string"), t.param("target", "RenderTarget"),
                   t.param("options", "RenderOptions", true)),
  "dispose": t.func("void", t.param("procId", "number")),
  "subscribe": t.func("void", t.param("tableId", "string")),
  "unsubscribe": t.func("void", t.param("tableId", "string")),
});

export const GristDocAPI = t.iface([], {
  "getDocName": t.func("string"),
  "listTables": t.func(t.array("string")),
  "fetchTable": t.func("any", t.param("tableId", "string")),
  "applyUserActions": t.func("any", t.param("actions", t.array(t.array("any")))),
});

export const GristView = t.iface([], {
  "fetchSelectedTable": t.func("any"),
});

const exportedTypeSuite: t.ITypeSuite = {
  ComponentKind,
  GristAPI,
  GristDocAPI,
  GristView,
};
export default exportedTypeSuite;
