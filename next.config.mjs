/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    outputFileTracingIncludes: {
      "/review": [
        "./proposals/proposal.schema.json",
        "./registry/mechanism.schema.json",
        "./effects/effect.schema.json",
        "./realizations/realization.schema.json",
        "./interactions/interaction.schema.json",
        "./dossiers/dossier.schema.json",
        "./corpora/realizations/realization-corpus.schema.json",
      ],
    },
  },
};

export default nextConfig;
