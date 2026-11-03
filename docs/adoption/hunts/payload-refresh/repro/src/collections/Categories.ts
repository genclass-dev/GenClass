import type { CollectionConfig } from 'payload'

// Reproduction only: every read of `categories` answers 1 s late, so the list view's `users` batch lands
// while the `categories` batch is still pending.
export const Categories: CollectionConfig = {
  slug: 'categories',
  admin: {
    useAsTitle: 'name',
  },
  hooks: {
    beforeOperation: [
      async ({ operation }) => {
        if (operation === 'read') {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      },
    ],
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
  ],
}
