<script setup lang="ts">
defineProps<{
  stats?: { buildings: number, backend: string }
}>()

const { seed, blocks } = useCitySettings()

function randomize() {
  seed.value = Math.floor(Math.random() * 1e6)
}
</script>

<template>
  <aside class="panel">
    <nav>
      <NuxtLink to="/">
        3D
      </NuxtLink>
      <NuxtLink to="/ascii">
        ASCII
      </NuxtLink>
    </nav>
    <label>
      Seed
      <input v-model.number="seed" type="number">
    </label>
    <label>
      Size: {{ blocks }} × {{ blocks }} blocks
      <input v-model.number="blocks" type="range" min="2" max="30">
    </label>
    <slot />
    <button type="button" @click="randomize">
      New city
    </button>
    <p v-if="stats" class="stats">
      {{ stats.buildings }} buildings · {{ stats.backend }}
    </p>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 16px;
  left: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 220px;
  padding: 14px 16px;
  background: rgb(255 255 255 / 0.85);
  backdrop-filter: blur(6px);
  border-radius: 10px;
  box-shadow: 0 4px 20px rgb(0 0 0 / 0.15);
}

nav {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: rgb(0 0 0 / 0.08);
  border-radius: 7px;
}

nav a {
  flex: 1;
  padding: 5px;
  border-radius: 5px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  color: #333;
  text-decoration: none;
}

nav a.router-link-exact-active {
  background: white;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
}

.panel :deep(label) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

button {
  padding: 8px;
  border: 0;
  border-radius: 6px;
  background: #2b5d8a;
  color: white;
  font-weight: 600;
  cursor: pointer;
}

.stats {
  margin: 0;
  font-size: 12px;
  color: #555;
}
</style>
