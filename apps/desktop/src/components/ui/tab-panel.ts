export function tabPanelProps(idPrefix: string, id: string) {
  return {
    role: 'tabpanel',
    id: `${idPrefix}-panel-${id}`,
    'aria-labelledby': `${idPrefix}-tab-${id}`,
  } as const;
}
