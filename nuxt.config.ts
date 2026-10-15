const envIds = ['city', 'forest', 'dragon']

export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },
  ssr: false,
  app: {
    head: { title: 'City Generator' },
  },
  experimental: {
    defaults: {
      // Prefetch another view's code on hover or focus, not as soon as its link is on screen.
      // Otherwise every page pulls in everything, e.g. the ASCII view downloads three.js.
      nuxtLink: { prefetchOn: { visibility: false, interaction: true } },
    },
  },
  nitro: {
    // Static hosts like GitHub Pages need a real file for every deep link.
    prerender: {
      routes: envIds.flatMap(id => [`/${id}`, `/${id}/ascii`, `/${id}/split`]),
    },
  },
})
