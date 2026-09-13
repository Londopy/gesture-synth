-module(community_ffi).
-export([raw_json/1, encode_dynamic/1]).

%% gleam_json represents `Json` as iodata on the Erlang target, so a binary
%% that already contains valid JSON text can be used directly as a `Json`
%% value without re-parsing it.
raw_json(Bin) when is_binary(Bin) -> Bin.

%% Re-encode a term produced by gleam_json's decoder (OTP `json:decode/1`
%% output: maps, lists, binaries, numbers, true/false/null) back to JSON text.
encode_dynamic(Term) -> iolist_to_binary(json:encode(Term)).
