import { PROJECT_BINDING_STATES, type ProjectBindingState } from "./types";

export { PROJECT_BINDING_STATES };
export type { ProjectBindingState };

export const PROJECT_BINDINGS_CONTROL_PATH = "/v1/attach/project-bindings";
export const PROJECT_BINDING_CONNECT_PATH = `${PROJECT_BINDINGS_CONTROL_PATH}/connect`;

export function projectBindingConnectPath(): string {
  return PROJECT_BINDING_CONNECT_PATH;
}

export function projectBindingStatusPath(bindingId: string): string {
  return `${PROJECT_BINDINGS_CONTROL_PATH}/${encodeURIComponent(bindingId)}/status`;
}

export function projectBindingConnectUrl(baseUrl: string | URL): string {
  return withBasePath(baseUrl, projectBindingConnectPath()).toString();
}

export function projectBindingStatusUrl(baseUrl: string | URL, bindingId: string): string {
  return withBasePath(baseUrl, projectBindingStatusPath(bindingId)).toString();
}

function withBasePath(baseUrl: string | URL, path: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${trimTrailingSlash(url.pathname)}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

function trimTrailingSlash(pathname: string): string {
  if (pathname === "/") return "";
  return pathname.replace(/\/+$/u, "");
}
