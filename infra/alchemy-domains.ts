const globalBaseDomain = "caplets.dev";

export interface AlchemyDomains {
  baseDomain: string;
  landingPageDomain: string;
  landingPageUrl: string;
  docsPageDomain: string;
  docsPageUrl: string;
  catalogPageDomain: string;
  catalogPageUrl: string;
}

export function buildAlchemyDomains(
  stage: string,
  { local = false }: { local?: boolean } = {},
): AlchemyDomains {
  const baseDomain = stage === "prod" ? globalBaseDomain : `${stage}.preview.${globalBaseDomain}`;
  const landingPageDomain = baseDomain;
  const docsPageDomain = `docs.${baseDomain}`;
  const catalogPageDomain = `catalog.${baseDomain}`;
  const landingPageUrl = local ? `http://localhost:4321` : `https://${landingPageDomain}`;
  const docsPageUrl = local ? `http://localhost:4322` : `https://${docsPageDomain}`;
  const catalogPageUrl = local ? `http://localhost:4323` : `https://${catalogPageDomain}`;

  return {
    baseDomain,
    landingPageDomain,
    landingPageUrl,
    docsPageDomain,
    docsPageUrl,
    catalogPageDomain,
    catalogPageUrl,
  };
}
