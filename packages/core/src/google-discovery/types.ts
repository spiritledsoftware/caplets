export type GoogleDiscoveryDocument = {
  kind?: string;
  id?: string;
  name?: string;
  version?: string;
  title?: string;
  rootUrl?: string;
  servicePath?: string;
  baseUrl?: string;
  auth?: { oauth2?: { scopes?: Record<string, { description?: string }> } };
  parameters?: Record<string, GoogleDiscoveryParameter>;
  schemas?: Record<string, GoogleDiscoverySchema>;
  methods?: Record<string, GoogleDiscoveryMethod>;
  resources?: Record<string, GoogleDiscoveryResource>;
};

export type GoogleDiscoveryResource = {
  methods?: Record<string, GoogleDiscoveryMethod>;
  resources?: Record<string, GoogleDiscoveryResource>;
};

export type GoogleDiscoveryMethod = {
  id?: string;
  path?: string;
  flatPath?: string;
  httpMethod?: string;
  description?: string;
  parameters?: Record<string, GoogleDiscoveryParameter>;
  parameterOrder?: string[];
  request?: { $ref?: string };
  response?: { $ref?: string };
  scopes?: string[];
  supportsMediaUpload?: boolean;
  supportsMediaDownload?: boolean;
  mediaUpload?: {
    accept?: string[];
    maxSize?: string;
    protocols?: Record<string, { path?: string; multipart?: boolean }>;
  };
};

export type GoogleDiscoveryParameter = GoogleDiscoverySchema & {
  location?: "path" | "query" | "header" | "body" | "media";
  required?: boolean;
  repeated?: boolean;
  deprecated?: boolean;
};

export type GoogleDiscoverySchema = {
  id?: string;
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  repeated?: boolean;
  properties?: Record<string, GoogleDiscoverySchema>;
  items?: GoogleDiscoverySchema;
  additionalProperties?: GoogleDiscoverySchema | boolean;
};
