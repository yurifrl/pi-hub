// cli/src/picker_types.ts — picker item shape shared by the picker driver and
// session views (docs/03-cli.md §Subcommands: picker rows carry
// name/id/description; phase is renderer chrome).

export type PickerItem = {
  id: string;
  name: string;
  description?: string;
  phase?: string;
};
