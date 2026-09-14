//// Stage boards: finished sets posted for a song, read back as the best set
//// per player. Friendly by design: there is no way to verify a score that
//// was produced by a camera in someone's room, so the board is a scoreboard
//// among people who chose to post, not a competition with stakes.

import community/auth
import community/ids
import community/json_codec
import community/store.{Score}
import community/web.{type Context, BadRequest}
import gleam/dict
import gleam/int
import gleam/json
import gleam/list
import gleam/option
import gleam/result
import gleam/string
import gleam/time/timestamp
import wisp.{type Request, type Response}

const ratings = ["rough", "loose", "steady", "tight", "pocket", "flawless"]

const variations = [
  "rehearsal", "halftime", "doubletime", "blind", "strict", "mirror",
]

/// GET /scores?song=<id>&limit=<n> -> { scores: [...] } best per player, highest first.
pub fn list(ctx: Context, request: Request) -> Response {
  web.respond({
    let params = wisp.get_query(request)
    use song_id <- result.try(case list.key_find(params, "song") {
      Ok(song) if song != "" -> web.check_length(song, "song", 1, 80)
      _ -> Error(BadRequest("song is required"))
    })
    let limit = case list.key_find(params, "limit") {
      Ok(text) -> int.parse(text) |> result.unwrap(10) |> int.clamp(1, 100)
      Error(_) -> 10
    }
    use scores <- result.try(
      ctx.store.list_scores(song_id, limit)
      |> result.map_error(web.store_error(_, "board not found")),
    )
    let authors =
      scores
      |> list.map(fn(s) { s.user_id })
      |> list.unique
      |> list.filter_map(fn(id) {
        ctx.store.get_user(id) |> result.map(fn(user) { #(id, user) })
      })
      |> dict.from_list
    let encoded =
      list.map(scores, fn(s) {
        json_codec.score(s, dict.get(authors, s.user_id) |> option.from_result)
      })
    Ok(web.json(
      200,
      json.object([#("scores", json.preprocessed_array(encoded))]),
    ))
  })
}

/// POST /scores (auth) { song_id, score, accuracy, run, rating, variations } -> 201 score
pub fn create(ctx: Context, request: Request) -> Response {
  web.respond({
    use user <- result.try(auth.authenticate(ctx, request))
    use body <- result.try(web.read_json(request, json_codec.score_decoder()))
    use song_id <- result.try(web.check_length(body.song_id, "song_id", 1, 80))
    use _ <- result.try(case body.score >= 0 && body.score <= 10_000_000 {
      True -> Ok(Nil)
      False -> Error(BadRequest("score must be between 0 and 10000000"))
    })
    use _ <- result.try(case body.accuracy >=. 0.0 && body.accuracy <=. 1.0 {
      True -> Ok(Nil)
      False -> Error(BadRequest("accuracy must be between 0 and 1"))
    })
    use _ <- result.try(case body.run >= 0 && body.run <= 100_000 {
      True -> Ok(Nil)
      False -> Error(BadRequest("run must be between 0 and 100000"))
    })
    use _ <- result.try(case list.contains(ratings, body.rating) {
      True -> Ok(Nil)
      False ->
        Error(BadRequest("rating must be one of " <> string.join(ratings, ", ")))
    })
    use _ <- result.try(
      case
        list.all(body.variations, list.contains(variations, _))
        && list.length(body.variations) <= 6
      {
        True -> Ok(Nil)
        False -> Error(BadRequest("unknown variation"))
      },
    )
    // Rehearsal sets cannot fail and score half; they stay on the local board.
    use _ <- result.try(case list.contains(body.variations, "rehearsal") {
      True -> Error(BadRequest("rehearsal sets are not posted to the board"))
      False -> Ok(Nil)
    })
    let score =
      Score(
        id: ids.new_id(),
        user_id: user.id,
        song_id:,
        score: body.score,
        accuracy: body.accuracy,
        run: body.run,
        rating: body.rating,
        variations: body.variations,
        created_at: timestamp.system_time(),
      )
    use score <- result.try(
      ctx.store.insert_score(score)
      |> result.map_error(web.store_error(_, "could not save the score")),
    )
    Ok(web.json(201, json_codec.score(score, option.Some(user))))
  })
}
