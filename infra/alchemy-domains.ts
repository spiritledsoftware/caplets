const globalBaseDomain = "caplets.dev";

export interface AlchemyDomains {
  baseDomain: string;
  landingPageDomain: string;
  landingPageUrl: string;
}

export function buildAlchemyDomains(
  stage: string,
  { local = false }: { local?: boolean } = {},
): AlchemyDomains {
  const baseDomain = stage === "prod" ? globalBaseDomain : `${stage}.preview.${globalBaseDomain}`;
  const landingPageDomain = baseDomain;
  const landingPageUrl = local ? `http://localhost:4321` : `https://${landingPageDomain}`;

  return {
    baseDomain,
    landingPageDomain,
    landingPageUrl,
  };
}
