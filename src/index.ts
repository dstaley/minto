import { minto } from "./minto";
import {
  collection,
  create,
  update,
  list,
  del,
  execute,
  sync,
} from "./collection";

// Usage
// const db = minto();
// const posts = collection(db, 'default', 'posts');
// await create(posts, { title: 'first post' });
// const p = await list(posts);
// for (const post of p.data) {
//     await update(posts, { ...post, timestamp: new Date().getTime() });
// }
// await del(posts, p.data[0].id);

// await sync(posts, { remote: "", headers: {} });

export { minto, collection, create, update, list, del, execute, sync };
