"""Pydantic-схемы для входящих WebSocket-сообщений."""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter


class OfferMsg(BaseModel):
    type: Literal["offer"]
    sdp: dict


class AnswerMsg(BaseModel):
    type: Literal["answer"]
    sdp: dict


class IceCandidateMsg(BaseModel):
    type: Literal["ice-candidate"]
    candidate: dict


class PongMsg(BaseModel):
    type: Literal["pong"]


class MediaStateMsg(BaseModel):
    """Уведомление о включении/выключении локальной камеры/микрофона."""
    type: Literal["media-state"]
    camera: bool
    mic: bool

class HangupMsg(BaseModel):
    """Явное завершение звонка пользователем."""
    type: Literal["hangup"]

WsMessage = Annotated[
    Union[OfferMsg, AnswerMsg, IceCandidateMsg, PongMsg, MediaStateMsg, HangupMsg],
    Field(discriminator="type"),
]

# TypeAdapter — единая точка для валидации, инициализируется один раз.
ws_message_adapter: TypeAdapter[WsMessage] = TypeAdapter(WsMessage)
