const globalBaseDomain = "caplets.dev";

export interface AlchemyDomains {
  baseDomain: string;
  landingPageDomain: string;
  landingPageUrl: string;
  docsPageDomain: string;
  docsPageUrl: string;
}

export function buildAlchemyDomains(
  stage: string,
  { local = false }: { local?: boolean } = {},
): AlchemyDomains {
  const baseDomain = stage === "prod" ? globalBaseDomain : `${stage}.preview.${globalBaseDomain}`;
  const landingPageDomain = baseDomain;
  const docsPageDomain = `docs.${baseDomain}`;
  const landingPageUrl = local ? `http://localhost:4321` : `https://${landingPageDomain}`;
  const docsPageUrl = local ? `http://localhost:4322` : `https://${docsPageDomain}`;

  return {
    baseDomain,
    landingPageDomain,
    landingPageUrl,
    docsPageDomain,
    docsPageUrl,
  };
}
