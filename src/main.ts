import { mount } from 'svelte';
// Brand fonts, self-hosted (Latin + Cyrillic subsets load on demand via unicode-range).
import '@fontsource-variable/commissioner';
import '@fontsource/onest/400.css';
import '@fontsource/onest/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles/brand-theme.css';
import './app.css';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });
