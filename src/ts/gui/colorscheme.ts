import { get, writable } from "svelte/store";
import { getDatabase, setDatabase } from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { BufferToText, selectSingleFile } from "../util";
import { notifyError } from "../alert";
import { isLite } from "../lite";
import { CustomCSSStore, SafeModeStore } from "../stores.svelte";

export interface ColorScheme{
    bgcolor: string;
    darkbg: string;
    borderc: string;
    selected: string;
    draculared: string;
    textcolor: string;
    textcolor2: string;
    darkBorderc: string;
    darkbutton: string;
    primary: string;
    type:'light'|'dark';
}


export const defaultColorScheme: ColorScheme = {
    bgcolor: "#282a36",
    darkbg: "#21222c",
    borderc: "#6272a4",
    selected: "#44475a",
    draculared: "#ff5555",
    textcolor: "#f8f8f2",
    textcolor2: "#64748b",
    darkBorderc: "#4b5563",
    darkbutton: "#374151",
    primary: "#3b82f6",
    type:'dark'
}

// Built-in palette pack (Catppuccin / Gruvbox). Spread into colorShemes after
// the kept classics so they sit in the upper half of the scheme dropdown. Keys
// follow the existing kebab-case convention; display names live in
// colorSchemeLabels.
const newColorSchemes = {
    "catppuccin-mocha": {
        bgcolor: "#1e1e2e",
        darkbg: "#181825",
        borderc: "#b4befe",
        selected: "#6c7086",
        draculared: "#f38ba8",
        textcolor: "#cdd6f4",
        textcolor2: "#a6adc8",
        darkBorderc: "#9399b2",
        darkbutton: "#45475a",
        primary: "#cba6f7",
        type:'dark'
    },
    "catppuccin-macchiato": {
        bgcolor: "#24273a",
        darkbg: "#1e2030",
        borderc: "#b7bdf8",
        selected: "#6e738d",
        draculared: "#ee99a0",
        textcolor: "#cad3f5",
        textcolor2: "#a5adcb",
        darkBorderc: "#8087a2",
        darkbutton: "#181926",
        primary: "#f5bde6",
        type:'dark'
    },
    "catppuccin-frappe": {
        bgcolor: "#303446",
        darkbg: "#292c3c",
        borderc: "#8caaee",
        selected: "#737994",
        draculared: "#e78284",
        textcolor: "#c6d0f5",
        textcolor2: "#a5adce",
        darkBorderc: "#949cbb",
        darkbutton: "#303446",
        primary: "#85c1dc",
        type:'dark'
    },
    "catppuccin-latte": {
        bgcolor: "#ccd0da",
        darkbg: "#bcc0cc",
        borderc: "#7287fd",
        selected: "#eff1f5",
        draculared: "#d20f39",
        textcolor: "#4c4f69",
        textcolor2: "#5c5f77",
        darkBorderc: "#e6e9ef",
        darkbutton: "#dce0e8",
        primary: "#df8e1d",
        type:'light'
    },
    "gruvbox-dark": {
        bgcolor: "#282828",
        darkbg: "#1d2021",
        borderc: "#3c3836",
        selected: "#504945",
        draculared: "#fabd2f",
        textcolor: "#ebdbb2",
        textcolor2: "#fbf1c7",
        darkBorderc: "#665c64",
        darkbutton: "#7c6f64",
        primary: "#fe8019",
        type:'dark'
    },
    "gruvbox-light": {
        bgcolor: "#fbf1c7",
        darkbg: "#f2e5bc",
        borderc: "#ebdbb2",
        selected: "#d5c4a1",
        draculared: "#d65d0e",
        textcolor: "#3c3836",
        textcolor2: "#282828",
        darkBorderc: "#bdae93",
        darkbutton: "#a89984",
        primary: "#fe8019",
        type:'light'
    },
} as const

const colorShemes = {
    "default": defaultColorScheme,
    "dark": {
        bgcolor: "#1a1a1a",
        darkbg: "#141414",
        borderc: "#525252",
        selected: "#3d3d3d",
        draculared: "#ff5555",
        textcolor: "#f5f5f5",
        textcolor2: "#a3a3a3",
        darkBorderc: "#404040",
        darkbutton: "#2e2e2e",
        primary: "#3b82f6",
        type:'dark'
    },
    "light": {
        bgcolor: "#ffffff",
        darkbg: "#f0f0f0",
        borderc: "#0f172a",
        selected: "#e0e0e0",
        draculared: "#ff5555",
        textcolor: "#0f172a",
        textcolor2: "#64748b",
        darkBorderc: "#d1d5db",
        darkbutton: "#e5e7eb",
        primary: "#2563eb",
        type:'light'
    },
    "realblack": {
        bgcolor: "#000000",
        darkbg: "#000000",
        borderc: "#6272a4",
        selected: "#44475a",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#64748b",
        darkBorderc: "#4b5563",
        darkbutton: "#374151",
        primary: "#3b82f6",
        type:'dark'
    },
    "monokai-light": {
        bgcolor: "#f8f8f2",
        darkbg: "#e8e8e3",
        borderc: "#75715e",
        selected: "#d8d8d0",
        draculared: "#f92672",
        textcolor: "#272822",
        textcolor2: "#75715e",
        darkBorderc: "#c0c0b8",
        darkbutton: "#d0d0c8",
        primary: "#f92672",
        type:'light'
    },
    "monokai-black": {
        bgcolor: "#272822",
        darkbg: "#1e1f1a",
        borderc: "#75715e",
        selected: "#3e3d32",
        draculared: "#f92672",
        textcolor: "#f8f8f2",
        textcolor2: "#a6a68a",
        darkBorderc: "#3e3d32",
        darkbutton: "#3e3d32",
        primary: "#f92672",
        type:'dark'
    },
    ...newColorSchemes,
    "cherry": {
        bgcolor: "#450a0a",
        darkbg: "#7f1d1d",
        borderc: "#ea580c",
        selected: "#d97706",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#fca5a5",
        darkBorderc: "#92400e",
        darkbutton: "#b45309",
        primary: "#fb923c",
        type:'dark'
    },
    "galaxy": {
        bgcolor: "#0f172a",
        darkbg: "#1f2a48",
        borderc: "#8be9fd",
        selected: "#457b9d",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#8be9fd",
        darkBorderc: "#457b9d",
        darkbutton: "#1f2a48",
        primary: "#a78bfa",
        type:'dark'
    },
    "nature": {
        bgcolor: "#1b4332",
        darkbg: "#2d6a4f",
        borderc: "#a8dadc",
        selected: "#4d908e",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#4d908e",
        darkBorderc: "#457b9d",
        darkbutton: "#2d6a4f",
        primary: "#52b788",
        type:'dark'
    },
    "lite": {
        bgcolor: "#1f2937",
        darkbg: "#1C2533",
        borderc: "#475569",
        selected: "#475569",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#64748b",
        darkBorderc: "#030712",
        darkbutton: "#374151",
        primary: "#3b82f6",
        type:'dark'
    }

} as const

export const ColorSchemeTypeStore = writable('dark' as 'dark'|'light')

export const colorSchemeList = Object.keys(colorShemes) as (keyof typeof colorShemes)[]

// Non-legacy schemes: the app default, the new palette pack, and the still-kept
// classics (dark / light / realblack / monokai). Everything else is a legacy
// scheme — hidden behind the "show legacy palettes" toggle and shown with a
// "(legacy)" suffix in the dropdown.
export const nonLegacyColorSchemes = new Set<string>([
    "default", "dark", "light", "realblack", "monokai-light", "monokai-black",
    ...Object.keys(newColorSchemes),
])

// Pretty display labels for the scheme keys (keys are kebab-case for data/code
// compatibility). "default" is localized separately via a lang key; any key
// without an entry falls back to the raw key.
export const colorSchemeLabels: Record<string, string> = {
    dark: "Dark",
    light: "Light",
    realblack: "Real Black",
    "monokai-light": "Monokai Light",
    "monokai-black": "Monokai Black",
    "catppuccin-mocha": "Catppuccin Mocha",
    "catppuccin-macchiato": "Catppuccin Macchiato",
    "catppuccin-frappe": "Catppuccin Frappé",
    "catppuccin-latte": "Catppuccin Latte",
    "gruvbox-dark": "Gruvbox Dark",
    "gruvbox-light": "Gruvbox Light",
    cherry: "Cherry",
    galaxy: "Galaxy",
    nature: "Nature",
    lite: "Lite",
}

export function changeColorScheme(colorScheme: string){
    try {
        let db = getDatabase()
        if(colorScheme !== 'custom'){
            db.colorScheme = safeStructuredClone(colorShemes[colorScheme])
        }
        db.colorSchemeName = colorScheme
        updateColorScheme()   
    } catch (error) {}
}

export function updateColorScheme(){
    try {
        let db = getDatabase()

        let colorScheme = db.colorScheme

        if(colorScheme == null){
            colorScheme = safeStructuredClone(defaultColorScheme)
        }

        if(get(isLite)){
            colorScheme = safeStructuredClone(colorShemes.lite)
        }

        //set css variables
        document.documentElement.style.setProperty("--risu-theme-bgcolor", colorScheme.bgcolor);
        document.documentElement.style.setProperty("--risu-theme-darkbg", colorScheme.darkbg);
        document.documentElement.style.setProperty("--risu-theme-borderc", colorScheme.borderc);
        document.documentElement.style.setProperty("--risu-theme-selected", colorScheme.selected);
        document.documentElement.style.setProperty("--risu-theme-draculared", colorScheme.draculared);
        document.documentElement.style.setProperty("--risu-theme-textcolor", colorScheme.textcolor);
        document.documentElement.style.setProperty("--risu-theme-textcolor2", colorScheme.textcolor2);
        document.documentElement.style.setProperty("--risu-theme-darkborderc", colorScheme.darkBorderc);
        document.documentElement.style.setProperty("--risu-theme-darkbutton", colorScheme.darkbutton);
        // Legacy data may lack `primary` (added later); fall back to default so
        // the toggle/CTA fill stays usable until the user picks a custom value.
        document.documentElement.style.setProperty("--risu-theme-primary", colorScheme.primary ?? defaultColorScheme.primary);
        ColorSchemeTypeStore.set(colorScheme.type)
    } catch (error) {}
}

export function changeColorSchemeType(type: 'light'|'dark'){
    try {
        let db = getDatabase()
        db.colorScheme.type = type
        updateColorScheme()
        updateTextThemeAndCSS()
    } catch (error) {}
}

export function exportColorScheme(){
    let db = getDatabase()
    let json = JSON.stringify(db.colorScheme)
    downloadFile('colorScheme.json', json)
}

export async function importColorScheme(){
    const uarray = await selectSingleFile(['json'])
    if(uarray == null){
        return
    }
    const string = BufferToText(uarray.data)
    let colorScheme: ColorScheme
    try{
        colorScheme = JSON.parse(string)
        if(
            typeof colorScheme.bgcolor !== 'string' ||
            typeof colorScheme.darkbg !== 'string' ||
            typeof colorScheme.borderc !== 'string' ||
            typeof colorScheme.selected !== 'string' ||
            typeof colorScheme.draculared !== 'string' ||
            typeof colorScheme.textcolor !== 'string' ||
            typeof colorScheme.textcolor2 !== 'string' ||
            typeof colorScheme.darkBorderc !== 'string' ||
            typeof colorScheme.darkbutton !== 'string' ||
            typeof colorScheme.type !== 'string'
        ){
            notifyError('Invalid color scheme')
            return
        }
        // `primary` is optional in old export files (pre-primary-token migration).
        // Backfill from the default so a re-export round-trips with the field set.
        if(typeof colorScheme.primary !== 'string'){
            colorScheme.primary = defaultColorScheme.primary
        }
        changeColorScheme('custom')
        let db = getDatabase()
        db.colorScheme = colorScheme
        updateColorScheme()
    }
    catch(e){
        notifyError('Invalid color scheme')
        return
    
    }
}

export function updateTextThemeAndCSS(){
    let db = getDatabase()
    const root = document.querySelector(':root') as HTMLElement;
    if(!root){
        return
    }
    let textTheme = get(isLite) ? 'standard' : db.textTheme
    let colorScheme = get(isLite) ? 'dark' : db.colorScheme.type
    switch(textTheme){
        case "standard":{
            if(colorScheme === 'dark'){
                root.style.setProperty('--FontColorStandard', '#fafafa');
                root.style.setProperty('--FontColorItalic', '#8C8D93');
                root.style.setProperty('--FontColorBold', '#fafafa');
                root.style.setProperty('--FontColorItalicBold', '#8C8D93');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }else{
                root.style.setProperty('--FontColorStandard', '#0f172a');
                root.style.setProperty('--FontColorItalic', '#8C8D93');
                root.style.setProperty('--FontColorBold', '#0f172a');
                root.style.setProperty('--FontColorItalicBold', '#8C8D93');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            break
        }
        case "highcontrast":{
            if(colorScheme === 'dark'){
                root.style.setProperty('--FontColorStandard', '#f8f8f2');
                root.style.setProperty('--FontColorItalic', '#F1FA8C');
                root.style.setProperty('--FontColorBold', '#8BE9FD');
                root.style.setProperty('--FontColorItalicBold', '#FFB86C');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            else{
                root.style.setProperty('--FontColorStandard', '#0f172a');
                root.style.setProperty('--FontColorItalic', '#F1FA8C');
                root.style.setProperty('--FontColorBold', '#8BE9FD');
                root.style.setProperty('--FontColorItalicBold', '#FFB86C');
                root.style.setProperty('--FontColorQuote1', '#8BE9FD');
                root.style.setProperty('--FontColorQuote2', '#FFB86C');
            }
            break
        }
        case "custom":{
            root.style.setProperty('--FontColorStandard', db.customTextTheme.FontColorStandard);
            root.style.setProperty('--FontColorItalic', db.customTextTheme.FontColorItalic);
            root.style.setProperty('--FontColorBold', db.customTextTheme.FontColorBold);
            root.style.setProperty('--FontColorItalicBold', db.customTextTheme.FontColorItalicBold);
            root.style.setProperty('--FontColorQuote1', db.customTextTheme.FontColorQuote1 ?? '#8BE9FD');
            root.style.setProperty('--FontColorQuote2', db.customTextTheme.FontColorQuote2 ?? '#FFB86C');
            break
        }
    }

    switch(db.font){
        case "default":{
            root.style.setProperty('--risu-font-family', 'Arial, sans-serif');
            break
        }
        case "timesnewroman":{
            root.style.setProperty('--risu-font-family', 'Times New Roman, serif');
            break
        }
        case "custom":{
            root.style.setProperty('--risu-font-family', db.customFont);
            break
        }
    }

    if(!get(SafeModeStore)){
        CustomCSSStore.set(db.customCSS ?? '')
    }
    else{
        CustomCSSStore.set('')
    }
}