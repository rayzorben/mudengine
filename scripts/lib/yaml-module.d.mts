import type { Plugin } from 'vite';

export function isYaml(id: string): boolean;
export function yamlModule(text: string): string;
export function yamlPlugin(): Plugin;
