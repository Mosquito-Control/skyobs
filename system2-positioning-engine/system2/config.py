from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://droneadmin:localpassword@localhost:5432/dronedetection"
    cameras_file: str = "cameras.yaml"
    max_distance_m: float = 500.0
    time_window_s: float = 1.0
    cache_size: int = 300
    loop_interval_s: float = 0.5
    db_flush_interval_s: float = 5.0
    # password for the read-only role granted to System 3
    reader_password: str = "system3reader"

    class Config:
        env_file = ".env"


settings = Settings()
