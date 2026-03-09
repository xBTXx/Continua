export type FileToolStatus = {
  id: string;
  label: string;
  status: "ok" | "error";
  details: string[];
};

export type CsvData = {
  headers: string[];
  rows: string[][];
};

export type ExtensionPolicy = {
  allowAny: boolean;
  extensions: Set<string>;
};
