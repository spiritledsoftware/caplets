const globalBaseDomain = "caplets.dev";

export interface AlchemyDomains {
  appDomain: string;
  baseDomain: string;
  cloudApiDomains: string[];
  cloudApiUrl: string;
  cloudDomain: string;
  cloudUiEnv: {
    VITE_CAPLETS_CLOUD_API_URL: string;
    VITE_CAPLETS_WORKSPACE_SLUG: string;
  };
  landingPageDomain: string;
  landingPageUrl: string;
  appUrl: string;
}

export function buildAlchemyDomains(
  stage: string,
  { local = false }: { local?: boolean } = {},
): AlchemyDomains {
  const baseDomain = stage === "prod" ? globalBaseDomain : `${stage}.preview.${globalBaseDomain}`;
  const landingPageDomain = baseDomain;
  const landingPageUrl = `https://${landingPageDomain}`;
  const cloudDomain = `cloud.${baseDomain}`;
  const cloudApiUrl = local ? "http://localhost:8787" : `https://${cloudDomain}`;
  const appDomain = `app.${baseDomain}`;
  const appUrl = `https://${appDomain}`;

  return {
    appDomain,
    baseDomain,
    cloudApiDomains: local ? [] : [cloudDomain],
    cloudApiUrl,
    cloudDomain,
    cloudUiEnv: {
      VITE_CAPLETS_CLOUD_API_URL: cloudApiUrl,
      VITE_CAPLETS_WORKSPACE_SLUG: "personal",
    },
    landingPageDomain,
    landingPageUrl,
    appUrl,
  };
}
