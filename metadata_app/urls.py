from django.urls import path
from . import views

urlpatterns = [
    path('', views.landing, name='landing'),
    path('login/', views.login_page, name='login_page'),
    path('logout/', views.logout_view, name='logout'),
    path('tool/', views.index, name='index'),
    path('api/analyze-metadata/', views.analyze_metadata, name='analyze_metadata'),
    path('api/image-to-prompt/', views.image_to_prompt, name='image_to_prompt'),
    path('api/render-eps/', views.render_eps, name='render_eps'),
    path('api/check-models/', views.check_models, name='check_models'),
    path('api/keys/', views.api_keys_list, name='api_keys_list'),
    path('api/keys/add/', views.api_keys_add, name='api_keys_add'),
    path('api/keys/delete/', views.api_keys_delete, name='api_keys_delete'),
    path('api/keys/activate/', views.api_keys_activate, name='api_keys_activate'),
    path('api/keys/first/', views.api_keys_get_first, name='api_keys_get_first'),
    path('api/settings/', views.api_settings_get, name='api_settings_get'),
    path('api/settings/save/', views.api_settings_save, name='api_settings_save'),
]
