<template>
    <div class="_icon-container">
        <div class="_icon-search-wrapper">
            <input v-model="query" class="_icon-search" placeholder="Search Icons">
        </div>
        <div>
            <div v-for="sprite in filteredSprites" :key="sprite.name" class="_icon-preview-wrapper">
                <h2 class="_icon-sprite-title">
                    {{ sprite.name }}
                </h2>
                <div v-for="symbol in sprite.symbols" :key="symbol.path" class="_icon-preview">
                    <div class="_icon-card">
                        <div class="_icon-svg">
                            <svg-icon :name="symbol.path" :title="symbol.path" class="icon" :width="size + 'px'"
                                :height="size + 'px'" />
                        </div>
                        <code class="_icon-name">
                            {{ symbol.name }}
                        </code>
                        <input class="_icon-name-input" type="text" readonly :value="symbol.path" @click="copy">
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup>
import sprites from '~svgsprite/sprites.json'

definePageMeta({
    layout: 'svg-sprite',
});

const props = defineProps({
    size: {
        type: Number,
        default: 60
    },
    onClick: {
        type: Function,
        default: () => () => { }
    }
})

let query = reactive('')

let sprites = sprites.map((sprite) => {
    const namespace = sprite.defaultSprite ? '' : `${sprite.name}/`
    return {
        name: sprite.name,
        symbols: sprite.symbols.map(symbol => ({
            name: symbol,
            path: `${namespace}${symbol}`
        }))
    }
})

let filteredSprites = computed(() => sprites.map(sprite => ({ ...sprite, symbols: sprite.symbols.filter(s => s.path.match(query)) })).filter(sprite => sprite.symbols.length))

const copy = (e) => {
    const el = e.target
    el.select()
    el.setSelectionRange(0, 99999)
    document.execCommand('copy')
    this.onClick(`Icon "${e.target.value}" copied to clipboard`)
}
</script>

<style scoped>
._icon-container {
    padding: 25px;
    max-width: 1050px;
    margin: 0 auto;
    box-sizing: border-box;
}

._icon-container * {
    box-sizing: inherit
}

._icon-search-wrapper {
    margin: 10px 25px;
}

._icon-sprite-title {
    width: 100%;
    text-align: center;
    text-transform: uppercase;
    font-family: monospace;
    letter-spacing: 0.1em;
}

._icon-search {
    width: 100%;
    height: 50px;
    font-size: 20px;
    text-indent: 10px;
}

._icon-preview-wrapper {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
}

._icon-preview {
    width: 200px;
    height: 200px;
    padding: 10px;
    text-align: center;
}

._icon-card {
    width: 100%;
    height: 100%;
    border-radius: 5px;
    padding: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    position: relative;
}

._icon-card:hover {
    box-shadow: 0 0 3px rgba(0, 0, 0, 0.2);
}

._icon-name {
    margin-top: 10px;
    font-family: monospace;
    width: 100%;
    color: #333;
    background: #fff;
    overflow: hidden;
    padding: 2px;
    border-radius: 3px;
}

._icon-name-input {
    position: absolute;
    width: 100%;
    height: 100%;

    left: 0;
    top: 0;
    bottom: 0;
    right: 0;
    opacity: 0;
    cursor: copy;
}
</style>
