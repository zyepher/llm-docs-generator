/** A comment on a discussion thread, as stored. `body` is the Markdown the author typed. */
export interface Comment {
  id: string;
  author: string;
  body: string;
  postedAt: string;
}
