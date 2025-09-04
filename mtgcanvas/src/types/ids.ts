// Branded identifier types (not yet adopted widely; provided for future migration)
export type InstanceId = number & { readonly __brand: "InstanceId" };
export type GroupId = number & { readonly __brand: "GroupId" };
