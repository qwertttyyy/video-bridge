from session_manager import SessionManager


def get_session_manager() -> SessionManager:
    """
    Заглушка-маркер. Реальная реализация подменяется в main.py
    через app.dependency_overrides на старте приложения.
    """
    raise RuntimeError(
        "get_session_manager не инициализирован — "
        "проверьте lifespan-функцию в main.py"
    )
