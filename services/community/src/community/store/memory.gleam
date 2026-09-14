//// In-memory `Store` implementation backed by a single OTP actor.
////
//// All state lives in the actor process, so concurrent HTTP handlers see a
//// consistent, serialised view. Used by tests and by dev mode when
//// `DATABASE_URL` is unset. Data is lost when the process exits.

import community/store.{
  type Comment, type Item, type ItemQuery, type Page, type Score, type Session,
  type ShortLink, type Store, type StoreError, type User, Conflict, NotFound,
  Page, ShortLink, Store,
}
import gleam/dict.{type Dict}
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/list
import gleam/option.{None, Some}
import gleam/order
import gleam/otp/actor
import gleam/result
import gleam/string
import gleam/time/timestamp

const call_timeout = 5000

// ---------------------------------------------------------------------------
// State & messages
// ---------------------------------------------------------------------------

type State {
  State(
    users: Dict(String, User),
    handles: Dict(String, String),
    sessions: Dict(String, Session),
    items: Dict(String, Item),
    /// Insertion sequence per item/comment id, used to break timestamp ties
    /// so ordering is deterministic.
    order: Dict(String, Int),
    seq: Int,
    likes: Dict(#(String, String), Nil),
    comments: Dict(String, Comment),
    links: Dict(String, ShortLink),
    item_links: Dict(String, String),
    scores: List(Score),
  )
}

pub opaque type Message {
  InsertUser(User, Subject(Result(User, StoreError)))
  GetUser(String, Subject(Result(User, StoreError)))
  GetUserByHandle(String, Subject(Result(User, StoreError)))
  InsertSession(Session, Subject(Result(Nil, StoreError)))
  GetSessionUser(String, Subject(Result(User, StoreError)))
  DeleteSession(String, Subject(Result(Nil, StoreError)))
  InsertItem(Item, Subject(Result(Item, StoreError)))
  GetItem(String, Subject(Result(Item, StoreError)))
  UpdateItem(Item, Subject(Result(Item, StoreError)))
  DeleteItem(String, Subject(Result(Nil, StoreError)))
  ListItems(ItemQuery, Subject(Result(Page(Item), StoreError)))
  ListRemixes(String, Subject(Result(List(Item), StoreError)))
  AddLike(String, String, Subject(Result(Int, StoreError)))
  RemoveLike(String, String, Subject(Result(Int, StoreError)))
  InsertComment(Comment, Subject(Result(Comment, StoreError)))
  GetComment(String, Subject(Result(Comment, StoreError)))
  ListComments(String, Subject(Result(List(Comment), StoreError)))
  DeleteComment(String, Subject(Result(Nil, StoreError)))
  GetOrCreateShortLink(String, String, Subject(Result(ShortLink, StoreError)))
  GetShortLink(String, Subject(Result(ShortLink, StoreError)))
  InsertScore(Score, Subject(Result(Score, StoreError)))
  ListScores(String, Int, Subject(Result(List(Score), StoreError)))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Start a fresh, empty in-memory store.
pub fn new() -> Result(Store, actor.StartError) {
  use started <- result.try(
    actor.new(empty_state())
    |> actor.on_message(handle_message)
    |> actor.start,
  )
  Ok(store_for(started.data))
}

/// Build a `Store` record whose functions all message the given actor.
fn store_for(s: Subject(Message)) -> Store {
  Store(
    kind: "memory",
    insert_user: fn(user) { call(s, InsertUser(user, _)) },
    get_user: fn(id) { call(s, GetUser(id, _)) },
    get_user_by_handle: fn(handle) { call(s, GetUserByHandle(handle, _)) },
    insert_session: fn(session) { call(s, InsertSession(session, _)) },
    get_session_user: fn(hash) { call(s, GetSessionUser(hash, _)) },
    delete_session: fn(hash) { call(s, DeleteSession(hash, _)) },
    insert_item: fn(item) { call(s, InsertItem(item, _)) },
    get_item: fn(id) { call(s, GetItem(id, _)) },
    update_item: fn(item) { call(s, UpdateItem(item, _)) },
    delete_item: fn(id) { call(s, DeleteItem(id, _)) },
    list_items: fn(query) { call(s, ListItems(query, _)) },
    list_remixes: fn(id) { call(s, ListRemixes(id, _)) },
    add_like: fn(user_id, item_id) { call(s, AddLike(user_id, item_id, _)) },
    remove_like: fn(user_id, item_id) {
      call(s, RemoveLike(user_id, item_id, _))
    },
    insert_comment: fn(comment) { call(s, InsertComment(comment, _)) },
    get_comment: fn(id) { call(s, GetComment(id, _)) },
    list_comments: fn(item_id) { call(s, ListComments(item_id, _)) },
    delete_comment: fn(id) { call(s, DeleteComment(id, _)) },
    get_or_create_short_link: fn(item_id, code) {
      call(s, GetOrCreateShortLink(item_id, code, _))
    },
    get_short_link: fn(code) { call(s, GetShortLink(code, _)) },
    insert_score: fn(score) { call(s, InsertScore(score, _)) },
    list_scores: fn(song_id, limit) { call(s, ListScores(song_id, limit, _)) },
  )
}

/// Synchronous request/reply to the store actor. A top-level function so it
/// is generic over the reply type (let-bound closures are monomorphic).
fn call(
  subject: Subject(Message),
  make_message: fn(Subject(reply)) -> Message,
) -> reply {
  process.call(subject, call_timeout, make_message)
}

fn empty_state() -> State {
  State(
    users: dict.new(),
    handles: dict.new(),
    sessions: dict.new(),
    items: dict.new(),
    order: dict.new(),
    seq: 0,
    likes: dict.new(),
    comments: dict.new(),
    links: dict.new(),
    item_links: dict.new(),
    scores: [],
  )
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

fn handle_message(
  state: State,
  message: Message,
) -> actor.Next(State, Message) {
  case message {
    InsertUser(user, reply) -> {
      case dict.has_key(state.handles, user.handle) {
        True -> {
          process.send(reply, Error(Conflict("handle")))
          actor.continue(state)
        }
        False -> {
          let state =
            State(
              ..state,
              users: dict.insert(state.users, user.id, user),
              handles: dict.insert(state.handles, user.handle, user.id),
            )
          process.send(reply, Ok(user))
          actor.continue(state)
        }
      }
    }

    GetUser(id, reply) -> {
      process.send(reply, lookup(state.users, id))
      actor.continue(state)
    }

    GetUserByHandle(handle, reply) -> {
      let result =
        lookup(state.handles, handle)
        |> result.try(lookup(state.users, _))
      process.send(reply, result)
      actor.continue(state)
    }

    InsertSession(session, reply) -> {
      let state =
        State(
          ..state,
          sessions: dict.insert(state.sessions, session.token_hash, session),
        )
      process.send(reply, Ok(Nil))
      actor.continue(state)
    }

    GetSessionUser(hash, reply) -> {
      let result =
        lookup(state.sessions, hash)
        |> result.try(fn(session) { lookup(state.users, session.user_id) })
      process.send(reply, result)
      actor.continue(state)
    }

    DeleteSession(hash, reply) -> {
      let state = State(..state, sessions: dict.delete(state.sessions, hash))
      process.send(reply, Ok(Nil))
      actor.continue(state)
    }

    InsertItem(item, reply) -> {
      let parent_ok = case item.parent_id {
        None -> True
        Some(parent) -> dict.has_key(state.items, parent)
      }
      case parent_ok {
        False -> {
          process.send(reply, Error(Conflict("parent_id")))
          actor.continue(state)
        }
        True -> {
          let state =
            State(
              ..state,
              items: dict.insert(state.items, item.id, item),
              order: dict.insert(state.order, item.id, state.seq),
              seq: state.seq + 1,
            )
          process.send(reply, Ok(item))
          actor.continue(state)
        }
      }
    }

    GetItem(id, reply) -> {
      process.send(reply, lookup(state.items, id))
      actor.continue(state)
    }

    UpdateItem(item, reply) -> {
      case dict.has_key(state.items, item.id) {
        False -> {
          process.send(reply, Error(NotFound))
          actor.continue(state)
        }
        True -> {
          let state =
            State(..state, items: dict.insert(state.items, item.id, item))
          process.send(reply, Ok(item))
          actor.continue(state)
        }
      }
    }

    DeleteItem(id, reply) -> {
      case dict.has_key(state.items, id) {
        False -> {
          process.send(reply, Error(NotFound))
          actor.continue(state)
        }
        True -> {
          // Cascade: likes, comments, short links; detach children.
          let likes = dict.filter(state.likes, fn(key, _) { key.1 != id })
          let comments =
            dict.filter(state.comments, fn(_, c) { c.item_id != id })
          let items =
            dict.delete(state.items, id)
            |> dict.map_values(fn(_, child) {
              case child.parent_id {
                Some(parent) if parent == id ->
                  store.Item(..child, parent_id: None)
                _ -> child
              }
            })
          let #(links, item_links) = case dict.get(state.item_links, id) {
            Ok(code) -> #(
              dict.delete(state.links, code),
              dict.delete(state.item_links, id),
            )
            Error(_) -> #(state.links, state.item_links)
          }
          let state =
            State(..state, items:, likes:, comments:, links:, item_links:)
          process.send(reply, Ok(Nil))
          actor.continue(state)
        }
      }
    }

    ListItems(query, reply) -> {
      process.send(reply, Ok(list_items(state, query)))
      actor.continue(state)
    }

    ListRemixes(id, reply) -> {
      let remixes =
        dict.values(state.items)
        |> list.filter(fn(item) { item.parent_id == Some(id) })
        |> sort_newest(state)
      process.send(reply, Ok(remixes))
      actor.continue(state)
    }

    AddLike(user_id, item_id, reply) -> {
      case dict.get(state.items, item_id) {
        Error(_) -> {
          process.send(reply, Error(NotFound))
          actor.continue(state)
        }
        Ok(item) -> {
          let key = #(user_id, item_id)
          case dict.has_key(state.likes, key) {
            True -> {
              process.send(reply, Ok(item.like_count))
              actor.continue(state)
            }
            False -> {
              let item = store.Item(..item, like_count: item.like_count + 1)
              let state =
                State(
                  ..state,
                  likes: dict.insert(state.likes, key, Nil),
                  items: dict.insert(state.items, item_id, item),
                )
              process.send(reply, Ok(item.like_count))
              actor.continue(state)
            }
          }
        }
      }
    }

    RemoveLike(user_id, item_id, reply) -> {
      case dict.get(state.items, item_id) {
        Error(_) -> {
          process.send(reply, Error(NotFound))
          actor.continue(state)
        }
        Ok(item) -> {
          let key = #(user_id, item_id)
          case dict.has_key(state.likes, key) {
            False -> {
              process.send(reply, Ok(item.like_count))
              actor.continue(state)
            }
            True -> {
              let item =
                store.Item(..item, like_count: int.max(0, item.like_count - 1))
              let state =
                State(
                  ..state,
                  likes: dict.delete(state.likes, key),
                  items: dict.insert(state.items, item_id, item),
                )
              process.send(reply, Ok(item.like_count))
              actor.continue(state)
            }
          }
        }
      }
    }

    InsertComment(comment, reply) -> {
      case dict.get(state.items, comment.item_id) {
        Error(_) -> {
          process.send(reply, Error(NotFound))
          actor.continue(state)
        }
        Ok(item) -> {
          let item = store.Item(..item, comment_count: item.comment_count + 1)
          let state =
            State(
              ..state,
              comments: dict.insert(state.comments, comment.id, comment),
              items: dict.insert(state.items, item.id, item),
              order: dict.insert(state.order, comment.id, state.seq),
              seq: state.seq + 1,
            )
          process.send(reply, Ok(comment))
          actor.continue(state)
        }
      }
    }

    GetComment(id, reply) -> {
      process.send(reply, lookup(state.comments, id))
      actor.continue(state)
    }

    ListComments(item_id, reply) -> {
      let comments =
        dict.values(state.comments)
        |> list.filter(fn(c) { c.item_id == item_id })
        |> list.sort(fn(a, b) {
          // Oldest first for comment threads.
          case timestamp.compare(a.created_at, b.created_at) {
            order.Eq -> int.compare(seq_of(state, a.id), seq_of(state, b.id))
            other -> other
          }
        })
      process.send(reply, Ok(comments))
      actor.continue(state)
    }

    DeleteComment(id, reply) -> {
      case dict.get(state.comments, id) {
        Error(_) -> {
          process.send(reply, Error(NotFound))
          actor.continue(state)
        }
        Ok(comment) -> {
          let items = case dict.get(state.items, comment.item_id) {
            Ok(item) ->
              dict.insert(
                state.items,
                item.id,
                store.Item(
                  ..item,
                  comment_count: int.max(0, item.comment_count - 1),
                ),
              )
            Error(_) -> state.items
          }
          let state =
            State(..state, items:, comments: dict.delete(state.comments, id))
          process.send(reply, Ok(Nil))
          actor.continue(state)
        }
      }
    }

    GetOrCreateShortLink(item_id, code, reply) -> {
      case dict.has_key(state.items, item_id) {
        False -> {
          process.send(reply, Error(NotFound))
          actor.continue(state)
        }
        True ->
          case dict.get(state.item_links, item_id) {
            Ok(existing) -> {
              process.send(reply, lookup(state.links, existing))
              actor.continue(state)
            }
            Error(_) ->
              case dict.has_key(state.links, code) {
                True -> {
                  process.send(reply, Error(Conflict("short_link_code")))
                  actor.continue(state)
                }
                False -> {
                  let link = ShortLink(code:, item_id:)
                  let state =
                    State(
                      ..state,
                      links: dict.insert(state.links, code, link),
                      item_links: dict.insert(state.item_links, item_id, code),
                    )
                  process.send(reply, Ok(link))
                  actor.continue(state)
                }
              }
          }
      }
    }

    GetShortLink(code, reply) -> {
      process.send(reply, lookup(state.links, code))
      actor.continue(state)
    }
    InsertScore(score, reply) -> {
      process.send(reply, Ok(score))
      actor.continue(State(..state, scores: [score, ..state.scores]))
    }
    ListScores(song_id, limit, reply) -> {
      process.send(reply, Ok(best_scores(state.scores, song_id, limit)))
      actor.continue(state)
    }
  }
}

/// Best set per user for a song, highest score first.
fn best_scores(
  scores: List(Score),
  song_id: String,
  limit: Int,
) -> List(Score) {
  scores
  |> list.filter(fn(s) { s.song_id == song_id })
  |> list.fold(dict.new(), fn(best: Dict(String, Score), s: Score) {
    case dict.get(best, s.user_id) {
      Ok(prev) if prev.score >= s.score -> best
      _ -> dict.insert(best, s.user_id, s)
    }
  })
  |> dict.values
  |> list.sort(fn(a, b) { int.compare(b.score, a.score) })
  |> list.take(limit)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn lookup(from: Dict(String, a), key: String) -> Result(a, StoreError) {
  dict.get(from, key) |> result.replace_error(NotFound)
}

fn seq_of(state: State, id: String) -> Int {
  dict.get(state.order, id) |> result.unwrap(0)
}

fn sort_newest(items: List(Item), state: State) -> List(Item) {
  list.sort(items, fn(a, b) {
    case timestamp.compare(b.created_at, a.created_at) {
      order.Eq -> int.compare(seq_of(state, b.id), seq_of(state, a.id))
      other -> other
    }
  })
}

fn list_items(state: State, query: ItemQuery) -> Page(Item) {
  let needle = option.map(query.q, string.lowercase)
  let matching =
    dict.values(state.items)
    |> list.filter(fn(item) {
      let kind_ok = case query.kind {
        None -> True
        Some(kind) -> item.kind == kind
      }
      let author_ok = case query.author {
        None -> True
        Some(author) -> item.author_id == author
      }
      let tag_ok = case query.tag {
        None -> True
        Some(tag) -> list.contains(item.tags, tag)
      }
      let q_ok = case needle {
        None -> True
        Some(q) ->
          string.contains(string.lowercase(item.title), q)
          || string.contains(string.lowercase(item.description), q)
      }
      kind_ok && author_ok && tag_ok && q_ok
    })

  let sorted = case query.sort {
    store.Newest -> sort_newest(matching, state)
    store.Top ->
      list.sort(matching, fn(a, b) {
        case int.compare(b.like_count, a.like_count) {
          order.Eq ->
            case timestamp.compare(b.created_at, a.created_at) {
              order.Eq -> int.compare(seq_of(state, b.id), seq_of(state, a.id))
              other -> other
            }
          other -> other
        }
      })
  }

  let total = list.length(sorted)
  let items =
    sorted
    |> list.drop({ query.page - 1 } * query.per_page)
    |> list.take(query.per_page)

  Page(items:, page: query.page, per_page: query.per_page, total:)
}
