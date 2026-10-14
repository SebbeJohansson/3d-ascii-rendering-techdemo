const envIds = ['city', 'forest', 'dragon']

export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },
  ssr: false,
  app: {
    head: { title: 'City Generator' },
  },
  nitro: {
    // Static hosts like GitHub Pages need a real file for every deep link.
    prerender: {
      routes: envIds.flatMap(id => [`/${id}`, `/${id}/ascii`, `/${id}/split`]),
    },
  },
})
