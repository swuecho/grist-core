import * as t from "ts-interface-checker";
// tslint:disable:object-literal-key-quotes

export const EditOptionsAPI = t.iface([], {
  "getParseOptions": t.func("ParseOptions", t.param("parseOptions", "ParseOptions", true)),
});

export const ParseFileAPI = t.iface([], {
  "parseFile": t.func("ParseFileResult", t.param("file", "FileSource"), t.param("parseOptions", "ParseOptions", true)),
});

export const ParseOptions = t.iface([], {
  "NUM_ROWS": t.opt("number"),
  "SCHEMA": t.opt(t.array("ParseOptionSchema")),
});

export const ParseOptionSchema = t.iface([], {
  "name": "string",
  "label": "string",
  "type": "string",
  "visible": "boolean",
});

export const FileSource = t.iface([], {
  "path": "string",
  "origName": "string",
});

export const ParseFileResult = t.iface(["GristTables"], {
  "parseOptions": "ParseOptions",
});

const exportedTypeSuite: t.ITypeSuite = {
  EditOptionsAPI,
  ParseFileAPI,
  ParseOptions,
  ParseOptionSchema,
  FileSource,
  ParseFileResult,
};
export default exportedTypeSuite;
