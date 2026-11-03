import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import sharp from 'sharp'

import { Users } from './collections/Users'
import { Media } from './collections/Media'
import { Categories } from './collections/Categories'
import { Posts } from './collections/Posts'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Media, Categories, Posts],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: sqliteAdapter({
    client: {
      url: process.env.DATABASE_URL || '',
    },
  }),
  sharp,
  plugins: [],
  onInit: async (payload) => {
    // Reproduction only: one user, 10 categories and 10 posts, each post related to a category and the user
    const { totalDocs } = await payload.count({ collection: 'users' })
    if (totalDocs > 0) return
    const user = await payload.create({
      collection: 'users',
      data: { email: 'dev@payloadcms.com', password: 'test' },
    })
    for (let i = 1; i <= 10; i++) {
      const category = await payload.create({ collection: 'categories', data: { name: `Category ${i}` } })
      await payload.create({
        collection: 'posts',
        data: { title: `Post ${i}`, category: category.id, author: user.id },
      })
    }
  },
})
